import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable, type TUI } from "@mariozechner/pi-tui";
import type { RuntimeSubagent } from "../../../subagent-sdk/types.js";
import { listGsdSubagents } from "../subagents.js";

function formatElapsed(subagent: RuntimeSubagent): string {
  const endedAt = subagent.completedAt ?? Date.now();
  const elapsedMs = Math.max(0, endedAt - subagent.startedAt);
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function summarizeText(value: string | undefined, maxLength = 84): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function formatStatusLabel(subagent: RuntimeSubagent): string {
  if (subagent.status === "failed") {
    return "failed";
  }
  if (subagent.status === "cancelled") {
    return "cancelled";
  }
  if (subagent.status === "completed") {
    return "done";
  }
  if (subagent.activity?.label !== undefined && subagent.activity.label.length > 0) {
    return subagent.activity.label;
  }
  return subagent.status;
}

function colorStatus(theme: Theme, subagent: RuntimeSubagent, label: string): string {
  if (subagent.status === "failed") {
    return theme.fg("error", label);
  }
  if (subagent.status === "cancelled") {
    return theme.fg("warning", label);
  }
  if (subagent.status === "completed") {
    return theme.fg("success", label);
  }
  return theme.fg("muted", label);
}

function buildPanelLines(theme: Theme, subagents: RuntimeSubagent[]): string[] {
  const runningCount = subagents.filter((subagent) => subagent.status === "running").length;
  const doneCount = subagents.filter(
    (subagent) =>
      subagent.status === "completed" ||
      subagent.status === "failed" ||
      subagent.status === "cancelled",
  ).length;

  const lines = [
    [
      `${subagents.length} total`,
      runningCount > 0 ? `${runningCount} running` : undefined,
      doneCount > 0 ? `${doneCount} done` : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" · "),
    "",
  ];

  if (subagents.length === 0) {
    lines.push("No GSD subagents active.");
    return lines;
  }

  for (const subagent of subagents) {
    const statusLabel = formatStatusLabel(subagent);
    lines.push(
      [
        theme.fg("accent", subagent.name),
        colorStatus(theme, subagent, statusLabel),
        theme.fg("dim", formatElapsed(subagent)),
        summarizeText(subagent.activity?.detail),
      ]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(theme.fg("dim", " · ")),
    );
  }

  return lines;
}

class GsdStatusPanel implements Focusable {
  readonly width = 96;
  focused = false;
  private renderTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionCommandContext,
    private readonly done: () => void,
  ) {
    this.renderTimer = setInterval(() => {
      this.tui.requestRender();
    }, 500);
    this.renderTimer.unref?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data.toLowerCase() === "q") {
      this.done();
    }
  }

  render(_width: number): string[] {
    const width = this.width;
    const innerWidth = width - 2;
    const subagents = listGsdSubagents(this.pi, this.ctx).toSorted(
      (left, right) => left.startedAt - right.startedAt,
    );
    const lines = buildPanelLines(this.theme, subagents);
    const row = (content: string) => {
      const padding = Math.max(0, innerWidth - visibleWidth(content));
      return (
        this.theme.fg("border", "│") + content + " ".repeat(padding) + this.theme.fg("border", "│")
      );
    };

    return [
      this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
      row(` ${this.theme.fg("accent", this.theme.bold("GSD Subagent Status"))}`),
      row(""),
      ...lines.map((line) => row(` ${line}`)),
      row(""),
      row(` ${this.theme.fg("dim", "Esc/q close • auto-refreshing live")}`),
      this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
    ];
  }

  invalidate(): void {}

  dispose(): void {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = undefined;
    }
  }
}

export async function handleGsdStatus(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) {
    const subagents = listGsdSubagents(pi, ctx);
    const summary =
      subagents.length === 0
        ? "No GSD subagents active."
        : subagents
            .map((subagent) => `${subagent.name}: ${formatStatusLabel(subagent)}`)
            .join("\n");
    ctx.ui.notify(summary, "info");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) => new GsdStatusPanel(tui, theme, pi, ctx, done),
  );
}
