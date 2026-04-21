import { DynamicBorder, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Key, Text, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import { formatUsd } from "./shared.js";

function renderUsageBar(
  theme: Theme,
  parts: { system: number; tools: number; convo: number; remaining: number },
  total: number,
  width: number,
): string {
  const w = Math.max(10, width);
  if (total <= 0) return "";

  const toCols = (n: number) => Math.round((n / total) * w);
  let sys = toCols(parts.system);
  let tools = toCols(parts.tools);
  let con = toCols(parts.convo);
  let rem = w - sys - tools - con;
  if (rem < 0) rem = 0;
  while (sys + tools + con + rem < w) rem++;
  while (sys + tools + con + rem > w && rem > 0) rem--;

  const block = "█";
  const sysStr = theme.fg("accent", block.repeat(sys));
  const toolsStr = theme.fg("warning", block.repeat(tools));
  const conStr = theme.fg("success", block.repeat(con));
  const remStr = theme.fg("dim", block.repeat(rem));
  return `${sysStr}${toolsStr}${conStr}${remStr}`;
}

function joinComma(items: string[]): string {
  return items.join(", ");
}

function joinCommaStyled(
  items: string[],
  renderItem: (item: string) => string,
  sep: string,
): string {
  return items.map((item) => renderItem(item)).join(sep);
}

type ContextViewData = {
  usage: {
    messageTokens: number;
    contextWindow: number;
    effectiveTokens: number;
    percent: number;
    remainingTokens: number;
    systemPromptTokens: number;
    agentTokens: number;
    toolsTokens: number;
    activeTools: number;
  } | null;
  agentFiles: string[];
  extensions: string[];
  skills: string[];
  loadedSkills: string[];
  session: { totalTokens: number; totalCost: number };
};

class ContextView implements Component {
  private tui: TUI;
  private theme: Theme;
  private onDone: () => void;
  private data: ContextViewData;
  private container: Container;
  private body: Text;
  private cachedWidth?: number;

  constructor(tui: TUI, theme: Theme, data: ContextViewData, onDone: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.data = data;
    this.onDone = onDone;

    this.container = new Container();
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    this.container.addChild(
      new Text(
        theme.fg("accent", theme.bold("Context")) + theme.fg("dim", "  (Esc/q/Enter to close)"),
        1,
        0,
      ),
    );
    this.container.addChild(new Text("", 1, 0));

    this.body = new Text("", 1, 0);
    this.container.addChild(this.body);

    this.container.addChild(new Text("", 1, 0));
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
  }

  private rebuild(width: number): void {
    const lines = [
      ...this.buildWindowUsageLines(width),
      ...this.buildTokenSummaryLines(),
      ...this.buildAgentExtensionLines(),
      this.buildSkillsLine(),
      "",
      this.buildSessionLine(),
    ];
    this.body.setText(lines.join("\n"));
    this.cachedWidth = width;
  }

  private buildWindowUsageLines(width: number): string[] {
    const muted = (s: string) => this.theme.fg("muted", s);
    const dim = (s: string) => this.theme.fg("dim", s);
    const text = (s: string) => this.theme.fg("text", s);
    if (this.data.usage === null) {
      return [muted("Window: ") + dim("(unknown)"), ""];
    }

    const u = this.data.usage;
    return [
      muted("Window: ") +
        text(`~${u.effectiveTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()}`) +
        muted(`  (${u.percent.toFixed(1)}% used, ~${u.remainingTokens.toLocaleString()} left)`),
      this.buildUsageBarLine(u, width),
      "",
    ];
  }

  private buildUsageBarLine(usage: NonNullable<ContextViewData["usage"]>, width: number): string {
    const dim = (s: string) => this.theme.fg("dim", s);
    const barWidth = Math.max(10, Math.min(36, width - 10));
    const sysInMessages = Math.min(usage.systemPromptTokens, usage.messageTokens);
    const convoInMessages = Math.max(0, usage.messageTokens - sysInMessages);
    return (
      renderUsageBar(
        this.theme,
        {
          system: sysInMessages,
          tools: usage.toolsTokens,
          convo: convoInMessages,
          remaining: usage.remainingTokens,
        },
        usage.contextWindow,
        barWidth,
      ) +
      " " +
      dim("sys") +
      this.theme.fg("accent", "█") +
      " " +
      dim("tools") +
      this.theme.fg("warning", "█") +
      " " +
      dim("convo") +
      this.theme.fg("success", "█") +
      " " +
      dim("free") +
      this.theme.fg("dim", "█")
    );
  }

  private buildTokenSummaryLines(): string[] {
    if (this.data.usage === null) {
      return [];
    }
    const muted = (s: string) => this.theme.fg("muted", s);
    const text = (s: string) => this.theme.fg("text", s);
    const u = this.data.usage;
    return [
      muted("System: ") +
        text(`~${u.systemPromptTokens.toLocaleString()} tok`) +
        muted(` (AGENTS ~${u.agentTokens.toLocaleString()})`),
      muted("Tools: ") +
        text(`~${u.toolsTokens.toLocaleString()} tok`) +
        muted(` (${u.activeTools} active)`),
    ];
  }

  private buildAgentExtensionLines(): string[] {
    const muted = (s: string) => this.theme.fg("muted", s);
    const text = (s: string) => this.theme.fg("text", s);
    return [
      muted(`AGENTS (${this.data.agentFiles.length}): `) +
        text(this.data.agentFiles.length > 0 ? joinComma(this.data.agentFiles) : "(none)"),
      "",
      muted(`Extensions (${this.data.extensions.length}): `) +
        text(this.data.extensions.length > 0 ? joinComma(this.data.extensions) : "(none)"),
    ];
  }

  private buildSkillsLine(): string {
    const muted = (s: string) => this.theme.fg("muted", s);
    const loaded = new Set(this.data.loadedSkills);
    const skillsRendered =
      this.data.skills.length > 0
        ? joinCommaStyled(
            this.data.skills,
            (name) =>
              loaded.has(name) ? this.theme.fg("success", name) : this.theme.fg("muted", name),
            this.theme.fg("muted", ", "),
          )
        : "(none)";
    return muted(`Skills (${this.data.skills.length}): `) + skillsRendered;
  }

  private buildSessionLine(): string {
    const muted = (s: string) => this.theme.fg("muted", s);
    const text = (s: string) => this.theme.fg("text", s);
    return (
      muted("Session: ") +
      text(`${this.data.session.totalTokens.toLocaleString()} tokens`) +
      muted(" · ") +
      text(formatUsd(this.data.session.totalCost))
    );
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q" ||
      data === "\r"
    ) {
      this.onDone();
    }
  }

  invalidate(): void {
    this.container.invalidate();
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) this.rebuild(width);
    return this.container.render(width);
  }
}

export { ContextView, joinComma };
export type { ContextViewData };
