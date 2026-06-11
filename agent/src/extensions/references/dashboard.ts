import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  parseKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ReferenceRuntimeState, ResolvedReference } from "./runtime.js";
import { errorMessage } from "../../utils/error-message.js";

export type ReferencesDashboardAction =
  | { type: "add" }
  | { type: "edit"; alias: string }
  | { type: "delete"; alias: string }
  | null;

export type ReferencesDashboardActions = {
  refresh(alias: string): Promise<ResolvedReference | undefined>;
  refreshAll(): Promise<ResolvedReference[]>;
  onError(message: string): void;
};

function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : "";
}

function fitLine(content: string, width: number): string {
  const trimmed = truncateToWidth(content, width, "…");
  const pad = Math.max(0, width - visibleWidth(trimmed));
  return `${trimmed}${repeat(" ", pad)}`;
}

function statusText(reference: ResolvedReference): string {
  if (reference.refreshing) {
    return "refreshing";
  }
  return reference.available ? "available" : "missing";
}

export function formatReferenceRefreshAge(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) {
    return "never";
  }

  const elapsedMs = Math.max(0, now - timestamp);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return "just now";
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function scopeText(reference: ResolvedReference): "global" | "project" {
  return reference.sourceFile.includes("/.pi/references.json") ? "project" : "global";
}

function statusColor(theme: Theme, reference: ResolvedReference, value: string): string {
  if (reference.refreshing) {
    return theme.fg("accent", value);
  }
  return reference.available ? theme.fg("success", value) : theme.fg("error", value);
}

function spinnerFrame(timestamp = Date.now()): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return frames[Math.floor(timestamp / 120) % frames.length] ?? "⠋";
}

function sourceText(reference: ResolvedReference): string {
  if (reference.kind === "local") {
    return reference.path ?? reference.resolvedPath;
  }
  const branch =
    reference.branch !== undefined && reference.branch.length > 0 ? `#${reference.branch}` : "";
  return `${reference.repository ?? ""}${branch}`;
}

function singleLineText(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

export function formatReferenceErrorForDisplay(error: string): string {
  const lines = error
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("hint:"));
  return singleLineText(lines.at(-1) ?? error);
}

function selectedReference(
  state: ReferenceRuntimeState,
  selectedIndex: number,
): ResolvedReference | undefined {
  return state.references[selectedIndex] ?? state.references[0];
}

function isRefreshAllKey(key: string | undefined): boolean {
  return key === "R" || key === "shift+r";
}

export class ReferencesDashboard implements Component, Focusable {
  private selectedIndex = 0;
  private readonly animationTimer: NodeJS.Timeout;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly state: ReferenceRuntimeState,
    private readonly actions: ReferencesDashboardActions,
    private readonly done: (action: ReferencesDashboardAction) => void,
  ) {
    this.animationTimer = setInterval(() => {
      if (this.state.references.some((reference) => reference.refreshing)) {
        this.requestRender();
      }
    }, 120);
    this.animationTimer.unref?.();
  }

  handleInput(data: string): void {
    const key = parseKey(data);
    if (key === Key.escape || key === "q") {
      this.done(null);
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
      this.selectedIndex = 0;
      this.requestRender();
      return;
    }
    if (key === Key.end) {
      this.selectedIndex = Math.max(0, this.state.references.length - 1);
      this.requestRender();
      return;
    }
    if (key === "a") {
      this.done({ type: "add" });
      return;
    }
    if (isRefreshAllKey(key)) {
      this.refreshAll();
      return;
    }

    const reference = selectedReference(this.state, this.selectedIndex);
    if (reference === undefined) {
      return;
    }
    if (key === "r") {
      this.refreshReference(reference.alias);
      return;
    }
    if (key === "e" || key === Key.enter) {
      this.done({ type: "edit", alias: reference.alias });
      return;
    }
    if (key === "d") {
      this.done({ type: "delete", alias: reference.alias });
    }
  }

  render(width: number): string[] {
    this.selectedIndex = Math.max(
      0,
      Math.min(this.selectedIndex, Math.max(0, this.state.references.length - 1)),
    );
    const dialogWidth = Math.max(56, width);
    const innerWidth = dialogWidth - 2;
    const border = this.theme.fg("border", "│");
    const top = this.theme.fg("borderAccent", `╭${repeat("─", innerWidth)}╮`);
    const bottom = this.theme.fg("borderAccent", `╰${repeat("─", innerWidth)}╯`);
    const total = this.state.references.length;
    const available = this.state.references.filter((reference) => reference.available).length;
    const refreshing = this.state.references.filter((reference) => reference.refreshing).length;
    const lines = [
      top,
      this.frame(this.theme.fg("accent", this.theme.bold(" References ")), innerWidth, border),
      this.frame(
        `${this.theme.fg("muted", "configured")} ${total}  ${this.theme.fg("success", "available")} ${available}  ${this.theme.fg("accent", "refreshing")} ${refreshing}`,
        innerWidth,
        border,
      ),
      this.frame("", innerWidth, border),
      ...this.renderList(innerWidth, border),
      this.frame("", innerWidth, border),
      ...this.renderDetails(innerWidth, border),
      this.frame("", innerWidth, border),
      this.frame(
        this.theme.fg(
          "dim",
          "↑/↓ select • r refresh • R all • a add • e/enter edit • d delete • q close",
        ),
        innerWidth,
        border,
      ),
      bottom,
    ];
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.animationTimer);
  }

  private moveSelection(delta: number): void {
    const count = this.state.references.length;
    if (count === 0) {
      return;
    }
    const next = this.selectedIndex + delta;
    this.selectedIndex = ((next % count) + count) % count;
    this.requestRender();
  }

  private requestRender(force = false): void {
    this.invalidate();
    this.tui.requestRender(force);
  }

  private refreshReference(alias: string): void {
    const reference = this.state.byAlias.get(alias);
    if (reference === undefined || reference.refreshing) {
      return;
    }
    void this.actions
      .refresh(alias)
      .then((result) => {
        if (result?.error !== undefined) {
          this.notifyError(formatReferenceFailure(result));
        }
      })
      .catch((error: unknown) => {
        this.notifyError(formatErrorMessage(error));
      })
      .finally(() => {
        this.requestRender();
      });
    this.requestRender();
  }

  private refreshAll(): void {
    if (this.state.references.every((reference) => reference.refreshing)) {
      return;
    }
    void this.actions
      .refreshAll()
      .then((results) => {
        const failed = results.filter((reference) => reference.error !== undefined);
        if (failed.length > 0) {
          this.notifyError(
            failed.length === 1
              ? formatReferenceFailure(failed[0])
              : `${failed.length} references failed. Select failed rows for details and suggestions.`,
          );
        }
      })
      .catch((error: unknown) => {
        this.notifyError(formatErrorMessage(error));
      })
      .finally(() => {
        this.requestRender();
      });
    this.requestRender();
  }

  private notifyError(message: string): void {
    this.actions.onError(message);
    this.requestRender();
  }

  private frame(content: string, innerWidth: number, border: string): string {
    return `${border}${fitLine(content, innerWidth)}${border}`;
  }

  private renderList(innerWidth: number, border: string): string[] {
    if (this.state.references.length === 0) {
      return [
        this.frame(
          this.theme.fg("dim", "No references configured. Press a to add one."),
          innerWidth,
          border,
        ),
      ];
    }

    return this.state.references.slice(0, 12).map((reference, index) => {
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg("accent", "›") : " ";
      const status = statusColor(
        this.theme,
        reference,
        reference.refreshing ? spinnerFrame() : "●",
      );
      const hidden = reference.hidden ? this.theme.fg("muted", " hidden") : "";
      const age = formatReferenceRefreshAge(reference.lastRefreshAt);
      const scope = this.theme.fg(
        scopeText(reference) === "project" ? "accent" : "warning",
        scopeText(reference),
      );
      const row = `${prefix} ${status} @${reference.alias} ${scope} ${this.theme.fg("muted", reference.kind)} ${sourceText(reference)} ${this.theme.fg("dim", `refreshed ${age}`)}${hidden}`;
      return this.frame(selected ? this.theme.bold(row) : row, innerWidth, border);
    });
  }

  private renderDetails(innerWidth: number, border: string): string[] {
    const reference = selectedReference(this.state, this.selectedIndex);
    if (reference === undefined) {
      return [];
    }
    const details = [
      this.theme.fg("accent", `@${reference.alias}`),
      `status: ${statusText(reference)}`,
      `scope: ${scopeText(reference)}`,
      `last refreshed: ${formatReferenceRefreshAge(reference.lastRefreshAt)}`,
      `path: ${reference.resolvedPath.length > 0 ? reference.resolvedPath : "(unresolved)"}`,
      `source: ${reference.sourceFile}`,
      `description: ${reference.description ?? "(none)"}`,
      ...(reference.error === undefined
        ? []
        : [`error: ${formatReferenceErrorForDisplay(reference.error)}`]),
      ...(reference.suggestion === undefined ? [] : [`suggestion: ${reference.suggestion}`]),
    ];
    return details.map((line) => this.frame(line, innerWidth, border));
  }
}

export async function showReferencesDashboard(
  ctx: ExtensionCommandContext,
  state: ReferenceRuntimeState,
  actions: ReferencesDashboardActions,
): Promise<ReferencesDashboardAction> {
  const action = await ctx.ui.custom<ReferencesDashboardAction>(
    (tui, theme, _keybindings, done) => new ReferencesDashboard(tui, theme, state, actions, done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        maxHeight: "90%",
        margin: 1,
      },
    },
  );
  return action;
}

function formatErrorMessage(error: unknown): string {
  return formatReferenceErrorForDisplay(errorMessage(error));
}

function formatReferenceFailure(reference: ResolvedReference): string {
  const suggestion =
    reference.suggestion === undefined ? "" : ` Suggestion: ${reference.suggestion}`;
  const error =
    reference.error === undefined
      ? "refresh failed"
      : formatReferenceErrorForDisplay(reference.error);
  return `@${reference.alias}: ${error}.${suggestion}`;
}

export function renderReferencesSummary(state: ReferenceRuntimeState): string {
  if (state.references.length === 0) {
    return "No references configured.";
  }
  return state.references
    .map((reference) =>
      [
        `@${reference.alias}`,
        reference.kind,
        statusText(reference),
        reference.resolvedPath || sourceText(reference),
      ].join(" — "),
    )
    .join("\n");
}
