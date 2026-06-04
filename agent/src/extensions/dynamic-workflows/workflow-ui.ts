/**
 * Interactive `/workflows` navigator, modeled on Claude Code's view:
 *
 * Runs ──enter──▶ phases ──enter──▶ agents ──enter──▶ agent detail ◀──esc─── ◀──esc──── ◀──esc────
 *
 * Keys: ↑/↓ (or j/k) select · enter/→ drill in · esc/← back (esc at top closes) p pause/resume · x
 * stop · r restart · s save · q quit
 *
 * The state machine and line rendering are pure and unit-tested; the pi-tui Component shell
 * (openWorkflowNavigator) wires them to live manager events.
 */

import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseKey } from "@earendil-works/pi-tui";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
import { WorkflowDialog } from "./workflow-dialog.js";
import {
  progressBar,
  renderActivityEventInline,
  renderAgentActivityLines,
  renderEventsSection,
  renderMetricLine,
  renderRunOverview,
  spinnerFrame,
  statusColor,
  truncate,
} from "./workflow-ui-render.js";
import type { PersistedRunState } from "./run-persistence.js";
import { registerSavedWorkflow } from "./saved-commands.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  queued: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  done: "✓",
  failed: "✗",
  error: "✗",
  aborted: "⊘",
  skipped: "⊘",
};

/** Minimal theme surface so rendering is testable without the real Theme class. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
  italic?: (text: string) => string;
}

const PLAIN: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

export type ViewKind = "runs" | "phases" | "agents" | "detail";

interface RunRow {
  runId: string;
  name: string;
  status: string;
  done: number;
  total: number;
  tokens: number;
}
interface PhaseRow {
  title: string;
  done: number;
  total: number;
  tokens: number;
}
interface AgentRow {
  id: number;
  label: string;
  status: string;
  phase?: string;
  tokens?: number;
  model?: string;
  activity?: string;
}

/**
 * Short, human-friendly model label: drop the provider prefix for display.
 *
 * @param {string | undefined} model Model name.
 * @returns {string | undefined} Short model name.
 */
function shortModel(model: string | undefined): string | undefined {
  if (model === undefined || model === "") return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** Reads run/phase/agent data from the manager, preferring live snapshots. */
export interface NavigatorModel {
  runs(): RunRow[];
  runName(runId: string): string;
  runStatus(runId: string): string;
  runSnapshot(runId: string): WorkflowSnapshot | undefined;
  phases(runId: string): PhaseRow[];
  agents(runId: string, phase: string): AgentRow[];
  agentDetail(runId: string, agentId: number): WorkflowAgentSnapshot | undefined;
}

function createNavigatorModel(
  manager: Pick<WorkflowManager, "listRuns" | "getRun">,
): NavigatorModel {
  const snapshot = (runId: string): { snapshot: WorkflowSnapshot; status: string } | undefined => {
    const live = manager.getRun(runId);
    if (live !== undefined) return { snapshot: live.snapshot, status: live.status };
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    if (persisted === undefined) return undefined;
    return { snapshot: persistedToSnapshot(persisted), status: persisted.status };
  };

  return {
    runs() {
      return manager.listRuns().map((p) => {
        const live = manager.getRun(p.runId);
        const agents = live?.snapshot.agents ?? p.agents;
        return {
          runId: p.runId,
          name: live?.snapshot.name ?? p.workflowName,
          status: live?.status ?? p.status,
          done: agents.filter((a) => a.status === "done").length,
          total: agents.length,
          tokens: (live?.snapshot.tokenUsage ?? p.tokenUsage)?.total ?? 0,
        };
      });
    },
    runName(runId: string) {
      return snapshot(runId)?.snapshot.name ?? runId;
    },
    runStatus(runId: string) {
      return snapshot(runId)?.status ?? "unknown";
    },
    runSnapshot(runId: string) {
      return snapshot(runId)?.snapshot;
    },
    phases(runId: string) {
      const snap = snapshot(runId)?.snapshot;
      if (snap === undefined) return [];
      const order = snap.phases.length > 0 ? [...snap.phases] : [];
      const byPhase = new Map<string, AgentRow[]>();
      for (const a of snap.agents) {
        const key = a.phase ?? "(no phase)";
        if (!byPhase.has(key)) byPhase.set(key, []);
        byPhase.get(key)?.push(a);
        if (!order.includes(key)) order.push(key);
      }
      return order.map((title) => {
        const agents = byPhase.get(title) ?? [];
        return {
          title,
          done: agents.filter((a) => a.status === "done").length,
          total: agents.length,
          tokens: agents.reduce((n, a) => n + (a.tokens ?? 0), 0),
        };
      });
    },
    agents(runId: string, phase: string) {
      const snap = snapshot(runId)?.snapshot;
      if (snap === undefined) return [];
      return snap.agents
        .filter((a) => (a.phase ?? "(no phase)") === phase)
        .map((a) => ({
          id: a.id,
          label: a.label,
          status: a.status,
          phase: a.phase,
          tokens: a.tokens,
          model: a.model,
          activity: a.activity,
        }));
    },
    agentDetail(runId: string, agentId: number) {
      return snapshot(runId)?.snapshot.agents.find((a) => a.id === agentId);
    },
  };
}

export const NavigatorModel = createNavigatorModel;

function resultPreview(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

function persistedToSnapshot(p: PersistedRunState): WorkflowSnapshot {
  return {
    name: p.workflowName,
    phases: p.phases,
    currentPhase: p.currentPhase,
    logs: p.logs,
    agents: p.agents.map((a) => ({
      id: a.id,
      label: a.label,
      phase: a.phase,
      prompt: a.prompt,
      status: a.status,
      resultPreview: resultPreview(a.result),
      error: a.error,
      model: a.model,
    })),
    agentCount: p.agents.length,
    runningCount: p.agents.filter((a) => a.status === "running").length,
    doneCount: p.agents.filter((a) => a.status === "done").length,
    errorCount: p.agents.filter((a) => a.status === "error").length,
    tokenUsage: p.tokenUsage ? { ...p.tokenUsage } : undefined,
    runId: p.runId,
  };
}

/** Navigation state machine: a stack of (view, cursor) frames plus detail scroll. */
export class NavigatorState {
  private stack: Array<{
    kind: ViewKind;
    cursor: number;
    runId?: string;
    phase?: string;
    agentId?: number;
  }> = [{ kind: "runs", cursor: 0 }];
  scroll = 0;

  private top(): {
    kind: ViewKind;
    cursor: number;
    runId?: string;
    phase?: string;
    agentId?: number;
  } {
    const frame = this.stack.at(-1);
    if (frame === undefined) throw new Error("Navigator stack is empty");
    return frame;
  }
  get kind(): ViewKind {
    return this.top().kind;
  }
  get cursor(): number {
    return this.top().cursor;
  }
  get runId(): string | undefined {
    return this.top().runId;
  }
  get phase(): string | undefined {
    return this.top().phase;
  }
  get agentId(): number | undefined {
    return this.top().agentId;
  }
  get depth(): number {
    return this.stack.length;
  }

  /**
   * Clamp the cursor to [0, count).
   *
   * @param {number} count Item count.
   */
  clamp(count: number) {
    const t = this.top();
    t.cursor = count <= 0 ? 0 : Math.max(0, Math.min(t.cursor, count - 1));
  }

  move(delta: number, count: number) {
    if (this.kind === "detail") {
      this.scroll = Math.max(0, this.scroll + delta);
      return;
    }
    if (count <= 0) return;
    const t = this.top();
    t.cursor = (t.cursor + delta + count) % count;
  }

  /**
   * Drill into the selected item. Returns true if the view changed.
   *
   * @param {NavigatorModel} model Navigator model.
   * @returns {boolean} Whether view changed.
   */
  drill(model: NavigatorModel): boolean {
    const t = this.top();
    if (t.kind === "runs") {
      const runs = model.runs();
      const run = runs[t.cursor];
      if (run === undefined) return false;
      this.stack.push({ kind: "phases", cursor: 0, runId: run.runId });
      return true;
    }
    if (t.kind === "phases" && t.runId !== undefined && t.runId !== "") {
      const phases = model.phases(t.runId);
      const ph = phases[t.cursor];
      if (ph === undefined) return false;
      this.stack.push({ kind: "agents", cursor: 0, runId: t.runId, phase: ph.title });
      return true;
    }
    if (
      t.kind === "agents" &&
      t.runId !== undefined &&
      t.runId !== "" &&
      t.phase !== undefined &&
      t.phase !== ""
    ) {
      const agents = model.agents(t.runId, t.phase);
      const ag = agents[t.cursor];
      if (ag === undefined) return false;
      this.scroll = 0;
      this.stack.push({
        kind: "detail",
        cursor: 0,
        runId: t.runId,
        phase: t.phase,
        agentId: ag.id,
      });
      return true;
    }
    return false;
  }

  /**
   * Pop one level. Returns false when already at the top (caller should close).
   *
   * @returns {boolean} Whether a level was popped.
   */
  back(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.scroll = 0;
    return true;
  }

  /**
   * The runId the current view acts on (for pause/stop/save).
   *
   * @param {NavigatorModel} model Navigator model.
   * @returns {string | undefined} Active run id.
   */
  activeRunId(model: NavigatorModel): string | undefined {
    if (this.runId !== undefined && this.runId !== "") return this.runId;
    if (this.kind === "runs") return model.runs()[this.cursor]?.runId;
    return undefined;
  }
}

function pad(n: number): string {
  return n.toLocaleString();
}

function fmtTokens(t: number): string {
  return t > 0 ? `${pad(t)} tok` : "";
}

/**
 * Build the lines for the current view. Pure: depends only on state + model + theme.
 *
 * @param {NavigatorState} state Navigator state.
 * @param {NavigatorModel} model Navigator model.
 * @param {number} width Render width.
 * @param {ThemeLike} theme Render theme.
 * @returns {string[]} Rendered lines.
 */
export function renderNavigator(
  state: NavigatorState,
  model: NavigatorModel,
  width: number,
  theme: ThemeLike = PLAIN,
): string[] {
  const lines: string[] = [];
  const sel = (i: number, text: string) =>
    i === state.cursor ? theme.fg("accent", theme.bold(`❯ ${text}`)) : `  ${text}`;
  const dim = (t: string) => theme.fg("dim", t);

  if (state.kind === "runs") {
    const runs = model.runs();
    state.clamp(runs.length);
    lines.push(theme.fg("accent", theme.bold("Workflows")));
    if (runs.length === 0) lines.push(dim("No runs yet. Start one with a background workflow."));
    runs.forEach((r, i) => {
      const icon = STATUS_ICON[r.status] ?? "?";
      const bar = progressBar(r.done, r.total, Math.max(8, Math.min(18, width - 48)));
      const meta = [`${r.done}/${r.total}`, fmtTokens(r.tokens)]
        .filter((part) => part !== "")
        .join(" · ");
      const status = theme.fg(statusColor(r.status), r.status);
      lines.push(sel(i, `${icon} ${r.name}  ${dim(r.runId)}  ${status}  ${bar}  ${dim(meta)}`));
    });
    const selectedRunId = runs[state.cursor]?.runId;
    if (selectedRunId !== undefined) {
      const selectedSnapshot = model.runSnapshot(selectedRunId);
      lines.push("");
      if (selectedSnapshot !== undefined) {
        lines.push(
          ...renderRunOverview({
            runId: selectedRunId,
            name: selectedSnapshot.name,
            status: model.runStatus(selectedRunId),
            snapshot: selectedSnapshot,
            width,
            theme,
          }),
        );
      }
      lines.push(...renderEventsSection(selectedSnapshot, theme));
    }
  } else if (state.kind === "phases" && state.runId !== undefined && state.runId !== "") {
    const phases = model.phases(state.runId);
    state.clamp(phases.length);
    lines.push(
      theme.fg("accent", theme.bold(model.runName(state.runId))) + dim(`  ${state.runId}`),
    );
    lines.push(renderMetricLine(theme, "status", model.runStatus(state.runId)));
    lines.push("");
    lines.push(theme.fg("muted", "phase".padEnd(28) + " progress       tokens"));
    lines.push(dim("-".repeat(Math.min(width - 2, 62))));
    phases.forEach((p, i) => {
      const bar = progressBar(p.done, p.total, 12);
      const meta = [`${p.done}/${p.total} agents`, fmtTokens(p.tokens)]
        .filter((part) => part !== "")
        .join(" · ");
      lines.push(sel(i, `${truncate(p.title, 26).padEnd(28)} ${bar}  ${dim(meta)}`));
    });
    lines.push(...renderEventsSection(model.runSnapshot(state.runId), theme));
  } else if (
    state.kind === "agents" &&
    state.runId !== undefined &&
    state.runId !== "" &&
    state.phase !== undefined &&
    state.phase !== ""
  ) {
    const agents = model.agents(state.runId, state.phase);
    const runId = state.runId;
    state.clamp(agents.length);
    lines.push(theme.fg("accent", theme.bold(`${model.runName(state.runId)} › ${state.phase}`)));
    lines.push(theme.fg("muted", "#   status    agent                         current activity"));
    lines.push(dim("-".repeat(Math.min(width - 2, 68))));
    agents.forEach((a, i) => {
      const icon = a.status === "running" ? spinnerFrame() : (STATUS_ICON[a.status] ?? "?");
      const mdl = shortModel(a.model);
      const meta = [mdl, a.tokens === undefined ? undefined : fmtTokens(a.tokens)]
        .filter((part) => part !== undefined && part !== "")
        .join(" · ");
      const latestActivity = model.agentDetail(runId, a.id)?.activityEvents?.at(-1);
      const activity =
        latestActivity === undefined
          ? dim(a.activity ?? meta)
          : renderActivityEventInline(latestActivity, theme);
      const status = theme.fg(statusColor(a.status), a.status.padEnd(8));
      lines.push(
        sel(
          i,
          `${String(a.id).padStart(2)}  ${icon} ${status} ${truncate(a.label, 28).padEnd(29)}${activity}`,
        ),
      );
    });
    lines.push(...renderEventsSection(model.runSnapshot(state.runId), theme));
  } else if (
    state.kind === "detail" &&
    state.runId !== undefined &&
    state.runId !== "" &&
    state.agentId !== undefined
  ) {
    const a = model.agentDetail(state.runId, state.agentId);
    lines.push(theme.fg("accent", theme.bold(a === undefined ? "agent" : a.label)));
    if (a !== undefined) {
      const body: string[] = [renderMetricLine(theme, "status", a.status ?? "")];
      if (a.model !== undefined && a.model !== "")
        body.push(renderMetricLine(theme, "mode/model", shortModel(a.model) ?? ""));
      if (a.tokens !== undefined)
        body.push(renderMetricLine(theme, "tokens", a.tokens.toLocaleString()));
      if (a.phase !== undefined && a.phase !== "")
        body.push(renderMetricLine(theme, "phase", a.phase));
      if (a.activity !== undefined && a.activity !== "")
        body.push(renderMetricLine(theme, "activity", a.activity));
      if (a.error !== undefined && a.error !== "")
        body.push(renderMetricLine(theme, "error", a.error));
      body.push("", theme.fg("accent", theme.bold("Live activity")));
      body.push(...renderAgentActivityLines(a, theme));
      body.push("", theme.fg("accent", theme.bold("Prompt")));
      body.push(...wrap(a.prompt ?? "", width));
      body.push("", theme.fg("accent", theme.bold("Result")));
      body.push(...wrap(a.resultPreview ?? "(none)", width));
      // Scrollable region.
      const maxScroll = Math.max(0, body.length - 1);
      state.scroll = Math.min(state.scroll, maxScroll);
      lines.push(...body.slice(state.scroll));
    }
  }

  lines.push("");
  lines.push(footerHint(state, theme));
  return lines;
}

function footerHint(state: NavigatorState, theme: ThemeLike): string {
  const parts =
    state.kind === "detail"
      ? ["j/k scroll", "esc back"]
      : [
          "↑/↓ select",
          "enter open",
          "esc back",
          "p pause",
          "x stop",
          "r restart",
          "s save",
          "q quit",
        ];
  return theme.fg("dim", parts.join(" · "));
}

function wrap(text: string, width: number): string[] {
  const w = Math.max(20, width - 2);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length <= w) {
      out.push(para);
      continue;
    }
    let rest = para;
    while (rest.length > w) {
      out.push(rest.slice(0, w));
      rest = rest.slice(w);
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** What a key press should do. Pure mapping from a parsed key id to an action. */
export type NavAction =
  | { type: "move"; delta: number }
  | { type: "drill" }
  | { type: "back" }
  | { type: "close" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "save" }
  | { type: "none" };

export function keyToAction(keyId: string | undefined, kind: ViewKind): NavAction {
  if (keyId === undefined) return { type: "none" };
  switch (keyId) {
    case "up":
      return { type: "move", delta: -1 };
    case "down":
      return { type: "move", delta: 1 };
    case "k":
      return { type: "move", delta: -1 };
    case "j":
      return { type: "move", delta: 1 };
    case "enter":
    case "return":
    case "right":
      return kind === "detail" ? { type: "none" } : { type: "drill" };
    case "escape":
    case "esc":
    case "left":
      return { type: "back" };
    case "q":
      return { type: "close" };
    case "p":
      return { type: "pause" };
    case "x":
      return { type: "stop" };
    case "r":
      return { type: "restart" };
    case "s":
      return { type: "save" };
    default:
      return { type: "none" };
  }
}

function currentCount(state: NavigatorState, model: NavigatorModel): number {
  if (state.kind === "runs") return model.runs().length;
  if (state.kind === "phases" && state.runId !== undefined && state.runId !== "")
    return model.phases(state.runId).length;
  if (
    state.kind === "agents" &&
    state.runId !== undefined &&
    state.runId !== "" &&
    state.phase !== undefined &&
    state.phase !== ""
  )
    return model.agents(state.runId, state.phase).length;
  return 0;
}

export interface NavigatorOptions {
  storage?: WorkflowStorage;
  cwd?: string;
}

function handleNavigatorAction(
  action: NavAction,
  state: NavigatorState,
  model: NavigatorModel,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  pi: ExtensionAPI,
  opts: NavigatorOptions,
  close: () => void,
): boolean {
  switch (action.type) {
    case "move":
      state.move(action.delta, currentCount(state, model));
      return true;
    case "drill":
      state.drill(model);
      return true;
    case "back":
      if (!state.back()) close();
      return true;
    case "close":
      close();
      return false;
    case "pause":
      return handleRunControl(state, model, manager, ui, "pause");
    case "stop":
      return handleRunControl(state, model, manager, ui, "stop");
    case "restart":
      return handleRestartAction(state, model, manager, ui);
    case "save":
      return handleSaveAction(state, model, manager, ui, pi, opts);
    case "none":
      return false;
  }
  return false;
}

function handleRunControl(
  state: NavigatorState,
  model: NavigatorModel,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  action: "pause" | "stop",
): boolean {
  const id = state.activeRunId(model);
  if (id === undefined || id === "") return true;
  const ok = action === "pause" ? manager.pause(id) : manager.stop(id);
  ui.notify(
    ok ? `${action === "pause" ? "Paused" : "Stopped"} ${id}` : `Cannot ${action} ${id}`,
    "info",
  );
  return true;
}

function selectedRun(state: NavigatorState, model: NavigatorModel, manager: WorkflowManager) {
  const id = state.activeRunId(model);
  return id === undefined || id === "" ? undefined : manager.listRuns().find((r) => r.runId === id);
}

function handleRestartAction(
  state: NavigatorState,
  model: NavigatorModel,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
): boolean {
  const run = selectedRun(state, model, manager);
  if (run?.script === undefined || run.script === "") {
    const id = state.activeRunId(model);
    ui.notify(
      id === undefined || id === ""
        ? "No run selected to restart"
        : `Cannot restart ${id} (no script saved)`,
      "warning",
    );
    return true;
  }
  const { runId: newId } = manager.startInBackground(run.script, run.args);
  ui.notify(
    `Restarted ${run.workflowName === "" ? "workflow" : run.workflowName} as ${newId}`,
    "info",
  );
  return true;
}

function handleSaveAction(
  state: NavigatorState,
  model: NavigatorModel,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  pi: ExtensionAPI,
  opts: NavigatorOptions,
): boolean {
  const run = selectedRun(state, model, manager);
  if (run?.script === undefined || run.script === "") {
    ui.notify("No saved run script to save", "warning");
  } else if (opts.storage === undefined) {
    ui.notify("Saving is not available (no storage)", "error");
  } else {
    const name = run.workflowName === "" ? "workflow" : run.workflowName;
    const saved = opts.storage.save({
      name,
      description: run.workflowName,
      script: run.script,
      location: "project",
    });
    registerSavedWorkflow(pi, opts.cwd ?? process.cwd(), saved);
    ui.notify(`Saved /${name}`, "info");
  }
  return true;
}

/**
 * Open the interactive `/workflows` navigator as a focused overlay. Resolves when the user closes
 * it (esc at the top level, or `q`).
 *
 * @param {ExtensionAPI} pi Extension API.
 * @param {WorkflowManager} manager Workflow manager.
 * @param {ExtensionUIContext} ui UI context.
 * @param {NavigatorOptions} opts Navigator options.
 * @returns {Promise<void>} Promise resolving when navigator closes.
 */
export function openWorkflowNavigator(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: NavigatorOptions = {},
): Promise<void> {
  const model = createNavigatorModel(manager);
  const state = new NavigatorState();

  return ui.custom<void>(
    (tui: TUI, theme: Theme, _keybindings, done: (r: void) => void) => {
      let dialog: WorkflowDialog | undefined;
      const refresh = () => {
        dialog?.refresh();
      };
      const events = [
        "agentStart",
        "agentActivity",
        "agentEnd",
        "phase",
        "log",
        "complete",
        "error",
        "stopped",
        "paused",
        "resumed",
      ];
      const onEvent = () => {
        refresh();
      };
      for (const ev of events) manager.on(ev, onEvent);
      const cleanup = () => {
        for (const ev of events) manager.off(ev, onEvent);
      };

      const close = () => {
        cleanup();
        done();
      };

      dialog = new WorkflowDialog(
        tui,
        theme,
        {
          getTitle: () => workflowDialogTitle(state, model),
          helpText: () => workflowDialogHelp(state),
          renderBody: (innerWidth) => renderNavigator(state, model, innerWidth, theme).slice(0, -2),
          onCachedScrollKey: (data, scrollBy) => {
            const action = keyToAction(parseKey(data), state.kind);
            if (state.kind !== "detail" || action.type !== "move") return false;
            scrollBy(action.delta);
            return true;
          },
          onKey: (data) => {
            const action = keyToAction(parseKey(data), state.kind);
            if (action.type === "none") return false;
            const shouldRender = handleNavigatorAction(
              action,
              state,
              model,
              manager,
              ui,
              pi,
              opts,
              close,
            );
            if (shouldRender) refresh();
            return true;
          },
        },
        close,
      );
      const component: Component & { dispose?(): void } = dialog;
      component.dispose = () => {
        dialog?.dispose();
        cleanup();
      };
      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-center",
        width: "78%",
        minWidth: 72,
        maxHeight: "88%",
        margin: { top: 1, left: 2, right: 2 },
        nonCapturing: true,
      },
      onHandle: (handle) => {
        handle.focus();
      },
    },
  );
}

function workflowDialogTitle(state: NavigatorState, model: NavigatorModel): string {
  if (state.kind === "runs") return "Workflows — runs";
  if (state.kind === "phases" && state.runId !== undefined) {
    return `Workflows — ${model.runName(state.runId)} phases`;
  }
  if (state.kind === "agents" && state.runId !== undefined && state.phase !== undefined) {
    return `Workflows — ${model.runName(state.runId)} › ${state.phase}`;
  }
  if (state.kind === "detail" && state.runId !== undefined && state.agentId !== undefined) {
    const agent = model.agentDetail(state.runId, state.agentId);
    return `Workflows — ${agent?.label ?? "agent detail"}`;
  }
  return "Workflows";
}

function workflowDialogHelp(state: NavigatorState): string {
  if (state.kind === "detail") {
    return "j/k or ↑/↓ scroll • Esc/← back • q close";
  }
  return "↑/↓ or j/k select • Enter/→ open • Esc/← back • p pause • x stop • r restart • s save • q close";
}
