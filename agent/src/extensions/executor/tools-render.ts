import { type Container, type Text } from "@mariozechner/pi-tui";
import {
  applyLinePrefix,
  createTextComponent,
  formatToolRail,
  getTextContent,
  renderStreamingPreview,
  summarizeLineCount,
  countTextLines,
} from "../coreui/tools.js";
import type { ExecuteToolDetails } from "./executor-adapter.js";
import {
  EXECUTE_STREAM_TAIL_LINES,
  hasStructuredContentDetails,
  type ExecuteRenderState,
  type ExecuteToolRenderContext,
  type ExecutorRenderTheme,
} from "./tools-shared.js";
import {
  appendCollapsedExecuteSummary,
  formatCollapsedCodePreview,
  formatExecuteCallHeader,
  readCode,
  readDuration,
  renderHighlightedLines,
  setExecuteCallComponent,
  syncExecuteRenderState,
} from "./tools-call-state.js";
import { renderExpandedExecuteResult } from "./tools-expanded.js";
import { buildExecuteSummary } from "./tools-summary.js";
import {
  extractExecutorDisplayValue,
  formatExecutorTextOutput,
  formatStructuredJson,
} from "./tools-text.js";

export const renderExecuteToolCall = (
  args: Record<string, unknown>,
  theme: ExecutorRenderTheme,
  context: ExecuteToolRenderContext,
): Container | Text => {
  const state = syncExecuteRenderState(context, context.isPartial);
  const rail = formatToolRail(theme, context);
  let phase: "pending" | "success" | "error" = "success";
  if (context.isError) {
    phase = "error";
  } else if (context.isPartial) {
    phase = "pending";
  }
  const header = formatExecuteCallHeader(args, theme, phase);
  const code = readCode(args);
  let callText: string;
  if (!context.argsComplete && code.length > 0) {
    const highlightedLines = renderHighlightedLines(code, "typescript");
    const footer = `${summarizeLineCount(countTextLines(code))} so far`;
    let preview = formatCollapsedCodePreview(highlightedLines, footer, theme);
    if (context.expanded) {
      preview = `${highlightedLines.join("\n")}\n${theme.fg("dim", "↳ ")}${theme.fg("muted", footer)}`;
    }
    callText = `${header}\n${preview}`;
  } else if (context.expanded && code.length > 0) {
    const highlightedCode = renderHighlightedLines(code, "typescript").join("\n");
    callText = `${header}\n\n${highlightedCode}`;
  } else {
    callText = header;
  }

  return setExecuteCallComponent(state, context.lastComponent, applyLinePrefix(callText, rail));
};

const renderExecuteToolErrorResult = (
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  details: ExecuteToolDetails | undefined,
  theme: ExecutorRenderTheme,
  context: ExecuteToolRenderContext,
  state: ExecuteRenderState,
  summary: string,
  expanded: boolean,
): Container | Text => {
  if (!expanded) {
    appendCollapsedExecuteSummary(state, `${theme.fg("muted", " · ")}${summary}`);
    return createTextComponent(context.lastComponent, "");
  }

  return renderExpandedExecuteResult(result, details, theme, context.lastComponent, summary, true);
};

const renderExecuteToolPartialResult = (
  structured: ReturnType<typeof extractExecutorDisplayValue>["structured"],
  text: string,
  theme: ExecutorRenderTheme,
  context: ExecuteToolRenderContext,
  expanded: boolean,
  summary: string,
): Container | Text => {
  let previewText = "";
  if (structured !== undefined) {
    previewText = formatStructuredJson(structured, theme);
  } else if (text.length > 0) {
    previewText = formatExecutorTextOutput(text, theme);
  }
  if (previewText.length > 0) {
    return renderStreamingPreview(previewText, theme, context.lastComponent, {
      expanded,
      footer: summary,
      tailLines: EXECUTE_STREAM_TAIL_LINES,
    });
  }

  return createTextComponent(
    context.lastComponent,
    `${formatToolRail(theme, context)}${theme.fg("dim", "↳ ")}${theme.fg("muted", summary)}`,
  );
};

export const renderExecuteToolResult = (
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: ExecutorRenderTheme,
  context: ExecuteToolRenderContext,
): Container | Text => {
  const state = syncExecuteRenderState(context, options.isPartial);
  const details =
    result.details !== null &&
    typeof result.details === "object" &&
    hasStructuredContentDetails(result.details)
      ? result.details
      : undefined;
  const displayValue = extractExecutorDisplayValue(result);
  const text = displayValue.text ?? getTextContent(result);
  const durationMs = readDuration(details, state);
  const summary = buildExecuteSummary(details, text, durationMs, theme, context.isError);
  if (context.isError) {
    return renderExecuteToolErrorResult(
      result,
      details,
      theme,
      context,
      state,
      summary,
      options.expanded,
    );
  }
  if (options.isPartial) {
    return renderExecuteToolPartialResult(
      displayValue.structured,
      text,
      theme,
      context,
      options.expanded,
      summary,
    );
  }
  if (!options.expanded) {
    appendCollapsedExecuteSummary(state, `${theme.fg("muted", " · ")}${summary}`);
    return createTextComponent(context.lastComponent, "");
  }

  return renderExpandedExecuteResult(result, details, theme, context.lastComponent, summary, false);
};
