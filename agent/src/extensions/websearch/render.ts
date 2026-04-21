import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { applyLinePrefix } from "../coreui/tools.js";
import {
  STREAM_PREVIEW_LINE_LIMIT,
  TOOL_TEXT_PADDING_X,
  TOOL_TEXT_PADDING_Y,
  isWebSearchRenderState,
  type ToolTheme,
  type WebSearchDetails,
  type WebSearchRenderState,
} from "./types.js";
import { buildExpandedMarkdown, formatDurationHuman } from "./parsing.js";

function renderWebSearchErrorResult(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  answer: string,
  theme: ToolTheme,
): Text {
  if (!expanded) {
    return createTextComponent(lastComponent, "");
  }
  const errorText = answer || "Web search failed.";
  return createTextComponent(
    lastComponent,
    `${rail}${theme.fg("error", "↳ ")}${theme.fg("error", errorText)}`,
  );
}

function renderWebSearchPartialResult(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  answer: string,
  durationMs: number | undefined,
  theme: ToolTheme,
): Text {
  const renderedText = renderToolOutput(answer, theme);
  const footer = durationMs === undefined ? "0s" : formatDurationHuman(durationMs);
  if (!renderedText) {
    return createTextComponent(
      lastComponent,
      `${rail}${theme.fg("dim", "↳ ")}${theme.fg("muted", footer)}`,
    );
  }
  return renderStreamingPreview(renderedText, theme, lastComponent, {
    expanded,
    footer,
    linePrefix: rail,
  });
}

function renderWebSearchCompleteResult(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  answer: string,
  details: WebSearchDetails | undefined,
  durationMs: number | undefined,
  theme: ToolTheme,
): Text | Container {
  const summary = buildWebSearchSummary(answer, details, durationMs, theme);
  if (!expanded) {
    return createTextComponent(lastComponent, `${rail}${theme.fg("dim", "↳ ")}${summary}`);
  }
  const container = lastComponent instanceof Container ? lastComponent : new Container();
  container.clear();
  container.addChild(
    new Markdown(
      (details?.markdown ?? buildExpandedMarkdown(answer || "No answer returned.", details)).trim(),
      TOOL_TEXT_PADDING_X,
      TOOL_TEXT_PADDING_Y,
      getMarkdownTheme(),
    ),
  );
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(`${rail}${theme.fg("dim", "↳ ")}${summary}`, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y),
  );
  return container;
}

function buildWebSearchSummary(
  answer: string,
  details: WebSearchDetails | undefined,
  durationMs: number | undefined,
  theme: ToolTheme,
): string {
  const groundedResultCount = details?.sources.length ?? 0;
  const summaryParts = [
    theme.fg("muted", answer ? "answered" : "no response"),
    theme.fg(
      "muted",
      `${groundedResultCount} grounded result${groundedResultCount === 1 ? "" : "s"}`,
    ),
  ];
  if (durationMs !== undefined) {
    summaryParts.push(theme.fg("muted", `took ${formatDurationHuman(durationMs)}`));
  }
  return summaryParts.join(theme.fg("muted", " · "));
}

function syncRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): WebSearchRenderState {
  const state = isWebSearchRenderState(context.state) ? context.state : {};
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
  if (isPartial && state.startedAt !== undefined && state.interval === undefined) {
    state.interval = setInterval(() => {
      context.invalidate();
    }, 1000);
    state.interval.unref?.();
  }
  if (!isPartial && state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
  return state;
}

function getElapsedMs(state: WebSearchRenderState): number | undefined {
  return state.startedAt === undefined
    ? undefined
    : (state.endedAt ?? Date.now()) - state.startedAt;
}

function renderToolOutput(
  text: string,
  theme: { fg: (color: "toolOutput", text: string) => string },
): string {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
}

function renderStreamingPreview(
  renderedText: string,
  theme: { fg: (color: "dim" | "muted" | "toolOutput", text: string) => string },
  lastComponent: unknown,
  options: { expanded: boolean; footer?: string; linePrefix?: string },
): Text {
  const lines = renderedText.split("\n").filter((line) => line.length > 0);
  if (options.expanded) {
    const footer =
      options.footer !== undefined && options.footer.length > 0
        ? `${theme.fg("dim", "↳ ")}${theme.fg("muted", options.footer)}`
        : "";
    return createTextComponent(
      lastComponent,
      applyLinePrefix([renderedText, footer].filter(Boolean).join("\n"), options.linePrefix),
    );
  }
  const visibleLines = lines.slice(-STREAM_PREVIEW_LINE_LIMIT);
  const blocks: string[] = [];
  if (lines.length > visibleLines.length) {
    blocks.push(
      `${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${lines.length - visibleLines.length} earlier lines)`)}`,
    );
  }
  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }
  if (options.footer !== undefined && options.footer.length > 0) {
    blocks.push(
      `${theme.fg("dim", "↳ ")}${theme.fg("muted", `${summarizeLineCount(lines.length)} so far (${options.footer})`)}`,
    );
  }
  return createTextComponent(lastComponent, applyLinePrefix(blocks.join("\n"), options.linePrefix));
}

function summarizeLineCount(lineCount: number): string {
  return `${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

function createTextComponent(lastComponent: unknown, text: string): Text {
  const component =
    lastComponent instanceof Text
      ? lastComponent
      : new Text("", TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y);
  component.setText(text);
  return component;
}

export {
  createTextComponent,
  getElapsedMs,
  renderWebSearchCompleteResult,
  renderWebSearchErrorResult,
  renderWebSearchPartialResult,
  syncRenderState,
};
