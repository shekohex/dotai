import type { ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Text, type Component, type TUI } from "@mariozechner/pi-tui";
import type { ExecutorConnectionAttempt, ExecutorEndpoint } from "./connection.js";
import { getExecutorSettings } from "./settings.js";
import { formatExecutorRuntimeState, getExecutorState } from "./status.js";

type ExecutorViewLine =
  | { kind: "blank" }
  | { kind: "heading"; text: string }
  | { kind: "kv"; label: string; value: string }
  | { kind: "text"; text: string };

type ExecutorViewData = {
  title: string;
  lines: ExecutorViewLine[];
};

class ExecutorView implements Component {
  private readonly container: Container;
  private readonly body: Text;
  private cachedWidth?: number;

  constructor(
    _tui: TUI,
    private readonly theme: Theme,
    private readonly data: ExecutorViewData,
    private readonly done: () => void,
  ) {
    this.container = new Container();
    this.container.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
    this.container.addChild(
      new Text(
        this.theme.fg("accent", this.theme.bold(this.data.title)) + this.theme.fg("dim", "  (Esc/q/Enter to close)"),
        1,
        0,
      ),
    );
    this.container.addChild(new Text("", 1, 0));
    this.body = new Text("", 1, 0);
    this.container.addChild(this.body);
    this.container.addChild(new Text("", 1, 0));
    this.container.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q" || data === "Q") {
      this.done();
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) {
      this.rebuild(width);
    }

    return this.container.render(width);
  }

  invalidate(): void {
    this.container.invalidate();
    this.cachedWidth = undefined;
  }

  dispose(): void {}

  private rebuild(width: number): void {
    const lines: string[] = [];
    const muted = (s: string) => this.theme.fg("muted", s);
    const text = (s: string) => this.theme.fg("text", s);

    for (const line of this.data.lines) {
      if (line.kind === "blank") {
        lines.push("");
        continue;
      }

      if (line.kind === "heading") {
        lines.push(this.theme.fg("accent", this.theme.bold(line.text)));
        continue;
      }

      if (line.kind === "kv") {
        lines.push(`${muted(`${line.label}: `)}${text(line.value)}`);
        continue;
      }

      lines.push(text(line.text));
    }

    this.body.setText(lines.join("\n"));
    this.cachedWidth = width;
  }
}

function buildRuntimeLines(ctx: ExtensionCommandContext, attempts?: ExecutorConnectionAttempt[]): ExecutorViewLine[] {
  const state = getExecutorState(ctx.cwd);
  const settings = getExecutorSettings();
  const lines: ExecutorViewLine[] = [{ kind: "heading", text: "Runtime" }];

  for (const line of formatExecutorRuntimeState(state)) {
    if (line === "Executor ready") {
      lines.push({ kind: "kv", label: "State", value: line });
      continue;
    }

    if (line === "Executor connecting" || line === "Executor idle") {
      lines.push({ kind: "kv", label: "State", value: line });
      continue;
    }

    if (line === "Executor error") {
      lines.push({ kind: "kv", label: "State", value: line });
      continue;
    }

    if (state.kind === "ready") {
      switch (line) {
        case `candidate: ${state.label}`:
          lines.push({ kind: "kv", label: "Candidate", value: state.label });
          break;
        case `mcpUrl: ${state.mcpUrl}`:
          lines.push({ kind: "kv", label: "MCP URL", value: state.mcpUrl });
          break;
        case `webUrl: ${state.webUrl}`:
          lines.push({ kind: "kv", label: "Web URL", value: state.webUrl });
          break;
        case `scopeId: ${state.scopeId}`:
          lines.push({ kind: "kv", label: "Scope ID", value: state.scopeId });
          break;
        case `scopeDir: ${state.scopeDir}`:
          lines.push({ kind: "kv", label: "Scope Dir", value: state.scopeDir });
          break;
        default:
          break;
      }
      continue;
    }

    if (state.kind === "error" && line === state.message) {
      lines.push({ kind: "text", text: line });
    }
  }

  if (attempts && attempts.length > 0) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "heading", text: "Probe Failures" });
    for (const attempt of attempts) {
      lines.push({ kind: "text", text: `${attempt.label}: ${attempt.error}` });
    }
  }

  lines.push({ kind: "blank" });
  lines.push({ kind: "heading", text: "Settings" });
  lines.push({ kind: "kv", label: "autoStart", value: String(settings.autoStart) });
  lines.push({ kind: "kv", label: "probeTimeoutMs", value: String(settings.probeTimeoutMs) });
  for (const candidate of settings.candidates) {
    lines.push({ kind: "kv", label: `candidate.${candidate.label}`, value: candidate.mcpUrl });
  }
  lines.push({ kind: "blank" });
  lines.push({ kind: "kv", label: "cwd", value: ctx.cwd });

  return lines;
}

function buildWebLines(endpoint: ExecutorEndpoint, launchError?: string): ExecutorViewLine[] {
  const lines: ExecutorViewLine[] = [
    { kind: "heading", text: "Executor UI" },
    { kind: "kv", label: "Candidate", value: endpoint.label },
    { kind: "kv", label: "MCP URL", value: endpoint.mcpUrl },
    { kind: "kv", label: "Web URL", value: endpoint.webUrl },
    { kind: "kv", label: "Scope ID", value: endpoint.scope.id },
    { kind: "kv", label: "Scope Dir", value: endpoint.scope.dir },
  ];

  if (launchError) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "heading", text: "Browser" });
    lines.push({ kind: "text", text: `Launch failed: ${launchError}` });
  }

  return lines;
}

function renderPlainText(title: string, lines: ExecutorViewLine[]): string {
  const rendered: string[] = [title];

  for (const line of lines) {
    if (line.kind === "blank") {
      rendered.push("");
    } else if (line.kind === "heading") {
      rendered.push(line.text);
    } else if (line.kind === "kv") {
      rendered.push(`${line.label}: ${line.value}`);
    } else {
      rendered.push(line.text);
    }
  }

  return rendered.join("\n");
}

async function showExecutorView(ctx: ExtensionCommandContext, data: ExecutorViewData): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(renderPlainText(data.title, data.lines), "info");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new ExecutorView(tui, theme, data, done));
}

export async function showExecutorStatusView(
  ctx: ExtensionCommandContext,
  attempts?: ExecutorConnectionAttempt[],
): Promise<void> {
  await showExecutorView(ctx, {
    title: "Executor",
    lines: buildRuntimeLines(ctx, attempts),
  });
}

export async function showExecutorWebView(
  ctx: ExtensionCommandContext,
  endpoint: ExecutorEndpoint,
  launchError?: string,
): Promise<void> {
  await showExecutorView(ctx, {
    title: "Executor",
    lines: buildWebLines(endpoint, launchError),
  });
}
