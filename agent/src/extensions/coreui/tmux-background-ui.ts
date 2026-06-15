import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { isStaleSessionReplacementContextError } from "../session-replacement.js";
import { formatDurationHuman } from "./tools-output.js";
import { registerBackgroundShellMessageRenderers } from "./tmux-background-messages.js";
import {
  BACKGROUND_SHELL_WIDGET_KEY,
  type BackgroundBashToolDetails,
  type BackgroundShellRun,
  type BackgroundShellStatus,
} from "./tmux-background-types.js";

const BACKGROUND_SHELL_SHORTCUT = Key.ctrlAlt("b");
const WIDGET_REFRESH_INTERVAL_MS = 1000;
const TERMINAL_RETENTION_MS = 15_000;
const OUTPUT_TAIL_LINES = 40;
const MAX_COMPACT_ROWS = 4;
const TMUX_KILL_TIMEOUT_MS = 2000;
const TMUX_LIST_TIMEOUT_MS = 2000;
const FULLSCREEN_MAX_LIST_ROWS = 8;
const TMUX_WINDOW_OPTIONS = {
  command: "@pi-bg-command",
  cwd: "@pi-bg-cwd",
  description: "@pi-bg-description",
  exitFile: "@pi-bg-exit-file",
  id: "@pi-bg-id",
  outputFile: "@pi-bg-output-file",
  pollIntervalMs: "@pi-bg-poll-interval-ms",
  startedAt: "@pi-bg-started-at",
} as const;
const execFileAsync = promisify(execFile);

type DashboardMode = "compact" | "expanded";
type ThemeLike = Pick<Theme, "fg" | "bold" | "italic">;

type BackgroundShellState = {
  ctx?: ExtensionContext;
  expanded: boolean;
  registeredControlApi?: ExtensionAPI;
  requestRender?: () => void;
  runs: Map<string, BackgroundShellRun>;
  timer?: ReturnType<typeof setInterval>;
};

const state: BackgroundShellState = {
  expanded: false,
  runs: new Map(),
};

export function registerBackgroundShellUI(pi: ExtensionAPI): void {
  if (hasBackgroundControlApi(pi) && state.registeredControlApi !== pi) {
    state.registeredControlApi = pi;
    registerCommands(pi);
  }
  if (typeof pi.registerMessageRenderer === "function") {
    registerBackgroundShellMessageRenderers(pi);
  }
  pi.on("session_start", async (_event, ctx) => {
    await restoreAndReconcileBackgroundShellRuns(ctx);
    renderBackgroundShellWidget(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restoreAndReconcileBackgroundShellRuns(ctx);
    renderBackgroundShellWidget(ctx);
  });
  pi.on("turn_end", async (_event, ctx) => {
    await restoreAndReconcileBackgroundShellRuns(ctx);
    renderBackgroundShellWidget(ctx);
  });
  pi.on("session_shutdown", () => {
    stopWidgetTimer();
    state.requestRender = undefined;
    state.ctx = undefined;
  });
}

function hasBackgroundControlApi(
  pi: ExtensionAPI,
): pi is ExtensionAPI & Pick<ExtensionAPI, "registerCommand" | "registerShortcut"> {
  return typeof pi.registerCommand === "function" && typeof pi.registerShortcut === "function";
}

export function trackBackgroundShellRun(ctx: ExtensionContext, run: BackgroundShellRun): void {
  state.runs.set(run.id, run);
  renderBackgroundShellWidget(ctx);
}

export function markBackgroundShellCompleted(
  id: string,
  exitCode: number,
  status: Extract<BackgroundShellStatus, "completed" | "failed" | "killed">,
): void {
  const run = state.runs.get(id);
  if (run === undefined) {
    return;
  }

  state.runs.set(id, { ...run, completedAt: Date.now(), exitCode, status });
  renderBackgroundShellWidget(state.ctx);
}

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("background", {
    description: "Show or control background tmux shell processes",
    getArgumentCompletions(prefix) {
      return ["toggle", "expand", "collapse", "fullscreen", "list", "peek", "kill"]
        .filter((item) => item.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      await handleBackgroundCommand(args, ctx);
    },
  });

  pi.registerShortcut(BACKGROUND_SHELL_SHORTCUT, {
    description: "Toggle background shell dashboard",
    handler(ctx) {
      state.expanded = !state.expanded;
      renderBackgroundShellWidget(ctx);
    },
  });
}

async function handleBackgroundCommand(args: string, ctx: ExtensionContext): Promise<void> {
  await restoreAndReconcileBackgroundShellRuns(ctx);
  const [action = "toggle", target] = args.trim().split(/\s+/);
  if (action === "fullscreen" || action === "full") {
    await showBackgroundShellFullscreen(ctx);
    return;
  }
  if (action === "expand") {
    state.expanded = true;
    renderBackgroundShellWidget(ctx);
    return;
  }
  if (action === "collapse") {
    state.expanded = false;
    renderBackgroundShellWidget(ctx);
    return;
  }
  if (action === "list") {
    ctx.ui.notify(formatRunList([...state.runs.values()]), "info");
    return;
  }
  if (action === "peek") {
    const run = findRun(target);
    if (run === undefined) {
      ctx.ui.notify("Background run not found.", "warning");
      return;
    }
    ctx.ui.notify(await readOutputTail(run.outputFile), "info");
    return;
  }
  if (action === "kill") {
    const run = findRun(target);
    if (run === undefined) {
      ctx.ui.notify("Background run not found.", "warning");
      return;
    }
    if (run.status !== "running") {
      ctx.ui.notify(`Background shell ${run.windowId} is ${run.status}; nothing to kill.`, "info");
      return;
    }
    await killRun(run);
    state.runs.set(run.id, { ...run, completedAt: Date.now(), status: "killed" });
    renderBackgroundShellWidget(ctx);
    ctx.ui.notify(`Killed background shell ${run.windowId}.`, "info");
    return;
  }

  state.expanded = !state.expanded;
  renderBackgroundShellWidget(ctx);
}

function restoreBackgroundShellRuns(ctx: ExtensionContext): void {
  try {
    const branch = ctx.sessionManager.getBranch?.() ?? [];
    for (const entry of branch as Array<{ result?: { details?: unknown }; type?: string }>) {
      const details = entry.result?.details;
      if (!isBackgroundDetails(details)) {
        continue;
      }
      const existing = state.runs.get(details.id);
      state.runs.set(details.id, {
        command: details.command,
        cwd: details.cwd,
        ...(details.description === undefined ? {} : { description: details.description }),
        exitFile: details.exitFile,
        id: details.id,
        outputFile: details.outputFile,
        ...(details.pollIntervalMs === undefined ? {} : { pollIntervalMs: details.pollIntervalMs }),
        startedAt: details.startedAt,
        status: existing?.status ?? details.status ?? "running",
        tmuxSession: details.tmuxSession,
        windowId: details.windowId,
      });
    }
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
  }
}

async function restoreAndReconcileBackgroundShellRuns(ctx: ExtensionContext): Promise<void> {
  restoreBackgroundShellRuns(ctx);
  await restoreTaggedTmuxRuns();
  await reconcileBackgroundShellRuns();
}

async function restoreTaggedTmuxRuns(): Promise<void> {
  const windows = await listTaggedTmuxWindows();
  for (const window of windows) {
    const existing = state.runs.get(window.id);
    state.runs.set(window.id, {
      command: window.command,
      cwd: window.cwd,
      ...(window.description.length === 0 ? {} : { description: window.description }),
      exitFile: window.exitFile,
      id: window.id,
      outputFile: window.outputFile,
      ...(window.pollIntervalMs === undefined ? {} : { pollIntervalMs: window.pollIntervalMs }),
      startedAt: window.startedAt,
      status: existing?.status ?? "running",
      tmuxSession: window.tmuxSession,
      windowId: window.windowId,
    });
  }
}

type TaggedTmuxWindow = Required<
  Pick<
    BackgroundShellRun,
    "command" | "cwd" | "exitFile" | "id" | "outputFile" | "startedAt" | "tmuxSession" | "windowId"
  >
> & {
  description: string;
  pollIntervalMs?: number;
};

async function listTaggedTmuxWindows(): Promise<TaggedTmuxWindow[]> {
  const format = [
    "#{session_name}",
    "#{window_id}",
    `#{${TMUX_WINDOW_OPTIONS.id}}`,
    `#{${TMUX_WINDOW_OPTIONS.command}}`,
    `#{${TMUX_WINDOW_OPTIONS.description}}`,
    `#{${TMUX_WINDOW_OPTIONS.cwd}}`,
    `#{${TMUX_WINDOW_OPTIONS.exitFile}}`,
    `#{${TMUX_WINDOW_OPTIONS.outputFile}}`,
    `#{${TMUX_WINDOW_OPTIONS.startedAt}}`,
    `#{${TMUX_WINDOW_OPTIONS.pollIntervalMs}}`,
  ].join("\t");

  try {
    const { stdout } = await execFileAsync("tmux", ["list-windows", "-a", "-F", format], {
      encoding: "utf-8",
      timeout: TMUX_LIST_TIMEOUT_MS,
    });
    return stdout
      .split("\n")
      .map((line) => parseTaggedTmuxWindow(line))
      .filter((window): window is TaggedTmuxWindow => window !== undefined);
  } catch {
    return [];
  }
}

function parseTaggedTmuxWindow(line: string): TaggedTmuxWindow | undefined {
  const [
    tmuxSession,
    windowId,
    id,
    command,
    description = "",
    cwd,
    exitFile,
    outputFile,
    startedAtText,
    pollIntervalText,
  ] = line.split("\t");
  const startedAt = Number(startedAtText);
  if (
    !tmuxSession ||
    !windowId ||
    !id ||
    !command ||
    !cwd ||
    !exitFile ||
    !outputFile ||
    !Number.isFinite(startedAt)
  ) {
    return undefined;
  }

  const pollIntervalMs =
    pollIntervalText === undefined || pollIntervalText.length === 0
      ? undefined
      : Number(pollIntervalText);
  return {
    command,
    cwd,
    description,
    exitFile,
    id,
    outputFile,
    ...(pollIntervalMs === undefined || !Number.isFinite(pollIntervalMs) ? {} : { pollIntervalMs }),
    startedAt,
    tmuxSession,
    windowId,
  };
}

async function reconcileBackgroundShellRuns(): Promise<boolean> {
  const taggedWindowIds = new Set((await listTaggedTmuxWindows()).map((window) => window.windowId));
  let changed = false;
  for (const run of state.runs.values()) {
    if (run.status !== "running") continue;
    const exitCode = await readExitCode(run.exitFile);
    if (exitCode !== undefined) {
      state.runs.set(run.id, {
        ...run,
        completedAt: Date.now(),
        exitCode,
        status: classifyExitCode(exitCode),
      });
      changed = true;
      continue;
    }
    if (!taggedWindowIds.has(run.windowId)) {
      state.runs.set(run.id, { ...run, completedAt: Date.now(), status: "missing" });
      changed = true;
    }
  }
  return changed;
}

async function readExitCode(exitFile: string): Promise<number | undefined> {
  try {
    const text = (await readFile(exitFile, "utf-8")).trim();
    if (!/^-?\d+$/.test(text)) return undefined;
    return Number(text);
  } catch {
    return undefined;
  }
}

function classifyExitCode(
  exitCode: number,
): Extract<BackgroundShellStatus, "completed" | "failed" | "killed"> {
  if (exitCode === 0) return "completed";
  if (exitCode === 130 || exitCode === 137 || exitCode === 143) return "killed";
  return "failed";
}

function isBackgroundDetails(
  details: unknown,
): details is Required<
  Pick<
    BackgroundBashToolDetails,
    "command" | "cwd" | "exitFile" | "id" | "outputFile" | "startedAt" | "tmuxSession" | "windowId"
  >
> &
  BackgroundBashToolDetails {
  if (typeof details !== "object" || details === null) return false;
  const value = details as BackgroundBashToolDetails;
  return (
    value.background === true &&
    typeof value.id === "string" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    typeof value.exitFile === "string" &&
    typeof value.outputFile === "string" &&
    typeof value.startedAt === "number" &&
    typeof value.tmuxSession === "string" &&
    typeof value.windowId === "string"
  );
}

function renderBackgroundShellWidget(ctx: ExtensionContext | undefined): void {
  try {
    if (ctx === undefined || !ctx.hasUI || typeof ctx.ui.setWidget !== "function") {
      return;
    }

    state.ctx = ctx;
    const visibleRuns = getVisibleRuns();
    ctx.ui.setWidget(
      BACKGROUND_SHELL_WIDGET_KEY,
      visibleRuns.length === 0
        ? undefined
        : createBackgroundShellWidget({
            mode: state.expanded ? "expanded" : "compact",
            runs: visibleRuns,
          }),
      { placement: "aboveEditor" },
    );
    syncWidgetTimer();
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
    state.ctx = undefined;
  }
}

function syncWidgetTimer(): void {
  if ([...state.runs.values()].some((run) => run.status === "running")) {
    if (state.timer === undefined) {
      state.timer = setInterval(() => {
        void reconcileBackgroundShellRuns().then((changed) => {
          if (changed) renderBackgroundShellWidget(state.ctx);
          state.requestRender?.();
        });
      }, WIDGET_REFRESH_INTERVAL_MS);
      state.timer.unref?.();
    }
    return;
  }
  stopWidgetTimer();
}

function stopWidgetTimer(): void {
  if (state.timer !== undefined) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}

function getVisibleRuns(): BackgroundShellRun[] {
  return [...state.runs.values()]
    .filter((run) => run.status === "running" || isTerminalRunVisible(run))
    .toSorted((left, right) => left.startedAt - right.startedAt);
}

function getAllRuns(): BackgroundShellRun[] {
  return [...state.runs.values()].toSorted((left, right) => left.startedAt - right.startedAt);
}

function isTerminalRunVisible(run: BackgroundShellRun): boolean {
  return Date.now() - (run.completedAt ?? run.startedAt) <= TERMINAL_RETENTION_MS;
}

function createBackgroundShellWidget(input: {
  mode: DashboardMode;
  runs: BackgroundShellRun[];
}): (tui: TUI, theme: Theme) => Component {
  return (tui, theme) => {
    state.requestRender = () => {
      tui.requestRender();
    };
    return {
      render(width: number): string[] {
        return renderBackgroundShellLines(input.runs, width, theme, input.mode, MAX_COMPACT_ROWS);
      },
      invalidate(): void {},
    };
  };
}

export function renderBackgroundShellLines(
  runs: BackgroundShellRun[],
  width: number,
  theme: ThemeLike,
  mode: DashboardMode,
  maxRows: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const title = renderTitleLine(runs, safeWidth, theme, mode);
  const visible = mode === "compact" ? runs.slice(0, Math.max(0, maxRows - 1)) : runs;
  const hidden = runs.length - visible.length;
  const rows = visible.map((run) =>
    truncateToWidth(formatRunLine(run, theme), safeWidth, "…", true),
  );
  if (hidden > 0 && rows.length > 0) {
    rows[rows.length - 1] = truncateToWidth(
      `  ${theme.fg("dim", `… ${hidden + 1} hidden background shells`)}`,
      safeWidth,
      "…",
      true,
    );
  }
  return [title, ...rows];
}

function renderTitleLine(
  runs: BackgroundShellRun[],
  width: number,
  theme: ThemeLike,
  mode: DashboardMode,
): string {
  const running = runs.filter((run) => run.status === "running").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const killed = runs.filter((run) => run.status === "killed").length;
  const countLabel = running > 0 ? `${runs.length} tracked` : `${runs.length} recent`;
  const parts = [
    theme.fg("accent", theme.bold("Background shells")),
    countLabel,
    running > 0 ? `${running} running` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    killed > 0 ? `${killed} killed` : undefined,
  ].filter((part): part is string => part !== undefined);
  const hints =
    mode === "compact"
      ? " /background toggle · ctrl+alt+b"
      : " /background fullscreen · ctrl+alt+b";
  return truncateToWidth(
    `${parts.join(theme.fg("dim", " · "))}${theme.fg("dim", hints)}`,
    width,
    "…",
    true,
  );
}

function formatRunLine(run: BackgroundShellRun, theme: ThemeLike): string {
  const status = theme.fg(statusTone(run.status), run.status);
  const elapsed = formatDurationHuman(Math.max(0, (run.completedAt ?? Date.now()) - run.startedAt));
  const poll =
    run.pollIntervalMs === undefined ? undefined : formatPollInterval(run.pollIntervalMs);
  const meta = [elapsed, run.windowId, poll]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  return `  ${theme.fg("text", run.description ?? summarizeCommand(run.command))} ${theme.fg("dim", "·")} ${status} ${theme.fg("dim", "·")} ${theme.fg("muted", meta)}`;
}

function runLabel(run: BackgroundShellRun): string {
  return run.description ?? summarizeCommand(run.command);
}

function formatPollInterval(intervalMs: number): string {
  return `polling every ${formatDurationHuman(intervalMs)}`;
}

function statusTone(
  status: BackgroundShellStatus,
): "success" | "warning" | "error" | "dim" | "muted" {
  if (status === "running") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  return "muted";
}

function summarizeCommand(command: string): string {
  return command.replaceAll(/\s+/g, " ").trim();
}

async function showBackgroundShellFullscreen(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  const runs = getAllRuns();
  if (runs.length === 0) {
    ctx.ui.notify("No background shells to show", "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new BackgroundShellDashboard(tui, theme, { done, getRuns: getAllRuns }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", margin: 1, maxHeight: "90%", width: "90%" },
    },
  );
}

class BackgroundShellDashboard implements Component, Focusable {
  private _focused = false;
  private selectedIndex = 0;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly input: { done: () => void; getRuns: () => BackgroundShellRun[] },
  ) {}

  handleInput(data: string): void {
    const key = parseKey(data);
    if (key === Key.escape || key === "q") {
      this.input.done();
      return;
    }
    if (key === Key.up || key === "k") {
      this.moveSelection(-1);
      return;
    }
    if (key === Key.down || key === "j") {
      this.moveSelection(1);
      return;
    }
    if (key === Key.home) {
      this.setSelection(0);
      return;
    }
    if (key === Key.end) {
      this.setSelection(Math.max(0, this.input.getRuns().length - 1));
      return;
    }
    if (key === "K" || key === "x") void this.killSelected();
  }

  render(width: number): string[] {
    const runs = this.input.getRuns();
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, runs.length - 1)));
    const dialogWidth = Math.max(64, width);
    const innerWidth = dialogWidth - 2;
    const border = this.theme.fg("border", "│");
    const top = this.theme.fg("borderAccent", `╭${repeat("─", innerWidth)}╮`);
    const bottom = this.theme.fg("borderAccent", `╰${repeat("─", innerWidth)}╯`);
    return [
      top,
      this.frame(
        this.theme.fg("accent", this.theme.bold(" Background shells ")),
        innerWidth,
        border,
      ),
      this.frame(renderFullscreenSummary(runs, this.theme), innerWidth, border),
      this.frame("", innerWidth, border),
      ...this.renderList(runs, innerWidth, border),
      this.frame("", innerWidth, border),
      ...this.renderDetails(runs[this.selectedIndex], innerWidth, border),
      this.frame("", innerWidth, border),
      this.frame(
        this.theme.fg("dim", this.formatShortcutHelp(runs[this.selectedIndex])),
        innerWidth,
        border,
      ),
      bottom,
    ];
  }

  invalidate(): void {}

  private frame(content: string, innerWidth: number, border: string): string {
    return `${border}${fitLine(content, innerWidth)}${border}`;
  }

  private moveSelection(delta: number): void {
    const count = this.input.getRuns().length;
    if (count === 0) return;
    this.setSelection((((this.selectedIndex + delta) % count) + count) % count);
  }

  private setSelection(index: number): void {
    this.selectedIndex = index;
    this.requestRender();
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private renderList(runs: BackgroundShellRun[], innerWidth: number, border: string): string[] {
    if (runs.length === 0)
      return [this.frame(this.theme.fg("dim", "No background shells."), innerWidth, border)];
    const listStart = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(FULLSCREEN_MAX_LIST_ROWS / 2),
        Math.max(0, runs.length - FULLSCREEN_MAX_LIST_ROWS),
      ),
    );
    return runs.slice(listStart, listStart + FULLSCREEN_MAX_LIST_ROWS).map((run, offset) => {
      const index = listStart + offset;
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "›") : " ";
      const status = this.theme.fg(statusTone(run.status), run.status.padEnd(9));
      const elapsed = formatDurationHuman(
        Math.max(0, (run.completedAt ?? Date.now()) - run.startedAt),
      );
      const poll =
        run.pollIntervalMs === undefined
          ? ""
          : this.theme.fg("dim", ` · ${formatPollInterval(run.pollIntervalMs)}`);
      const row = `${prefix} ${status} ${this.theme.fg("muted", elapsed.padEnd(8))} ${this.theme.fg("dim", run.windowId.padEnd(5))} ${runLabel(run)}${poll}`;
      return this.frame(selected ? this.theme.bold(row) : row, innerWidth, border);
    });
  }

  private renderDetails(
    run: BackgroundShellRun | undefined,
    innerWidth: number,
    border: string,
  ): string[] {
    if (run === undefined) return [];
    return [
      this.frame(this.theme.fg("accent", runLabel(run)), innerWidth, border),
      this.frame(`status: ${run.status}`, innerWidth, border),
      this.frame(
        `uptime: ${formatDurationHuman(Math.max(0, (run.completedAt ?? Date.now()) - run.startedAt))}`,
        innerWidth,
        border,
      ),
      this.frame(`window: ${run.windowId} (${run.tmuxSession})`, innerWidth, border),
      this.frame(`command: ${run.command}`, innerWidth, border),
      this.frame(`output: ${run.outputFile}`, innerWidth, border),
      this.frame(formatPeekHint(run), innerWidth, border),
      this.frame(formatKillHint(run), innerWidth, border),
    ];
  }

  private async killSelected(): Promise<void> {
    const run = this.input.getRuns()[this.selectedIndex];
    if (run === undefined) return;
    if (run.status !== "running") return;
    await killRun(run);
    state.runs.set(run.id, { ...run, completedAt: Date.now(), status: "killed" });
    renderBackgroundShellWidget(state.ctx);
    this.requestRender();
  }

  private formatShortcutHelp(run: BackgroundShellRun | undefined): string {
    const killHelp = run?.status === "running" ? " • K/x kill" : " • inspect-only";
    return `↑/↓ select${killHelp} • q close`;
  }
}

function formatPeekHint(run: BackgroundShellRun): string {
  if (run.status === "running") {
    return `peek: tmux capture-pane -t ${run.windowId} -p -S -200`;
  }

  return `peek: tail -n 200 ${run.outputFile}`;
}

function formatKillHint(run: BackgroundShellRun): string {
  if (run.status !== "running") {
    return `kill: unavailable · ${run.status} commands are inspect-only`;
  }

  return `kill: K/x stop · tmux kill-window -t ${run.windowId}`;
}

function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : "";
}

function fitLine(content: string, width: number): string {
  const trimmed = truncateToWidth(content, width, "…");
  const pad = Math.max(0, width - visibleWidth(trimmed));
  return `${trimmed}${repeat(" ", pad)}`;
}

function renderFullscreenSummary(runs: BackgroundShellRun[], theme: ThemeLike): string {
  const running = runs.filter((run) => run.status === "running").length;
  const completed = runs.filter((run) => run.status === "completed").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const killed = runs.filter((run) => run.status === "killed").length;
  return `${theme.fg("muted", "tracked")} ${runs.length}  ${theme.fg("warning", "running")} ${running}  ${theme.fg("success", "completed")} ${completed}  ${theme.fg("error", "failed")} ${failed}  ${theme.fg("muted", "killed")} ${killed}`;
}

async function killRun(run: BackgroundShellRun): Promise<void> {
  await execFileAsync("tmux", ["kill-window", "-t", run.windowId], {
    timeout: TMUX_KILL_TIMEOUT_MS,
  }).catch(() => {});
}

function findRun(target: string | undefined): BackgroundShellRun | undefined {
  if (target === undefined || target.length === 0) return getVisibleRuns()[0];
  return [...state.runs.values()].find((run) => run.id === target || run.windowId === target);
}

function formatRunList(runs: BackgroundShellRun[]): string {
  if (runs.length === 0) return "No background shells.";
  return runs
    .map(
      (run) =>
        `${run.windowId} ${run.status} ${formatDurationHuman(Date.now() - run.startedAt)} ${run.command}`,
    )
    .join("\n");
}

async function readOutputTail(outputFile: string, lines = OUTPUT_TAIL_LINES): Promise<string> {
  try {
    await access(outputFile);
    const output = (await readFile(outputFile, "utf-8")).trimEnd();
    if (output.length === 0) return "(no output)";
    return Number.isFinite(lines) ? output.split("\n").slice(-lines).join("\n") : output;
  } catch {
    return "(no output yet)";
  }
}
