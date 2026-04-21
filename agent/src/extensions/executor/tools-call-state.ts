import { Text } from "@mariozechner/pi-tui";
import {
  countTextLines,
  createTextComponent,
  formatDurationHuman,
  summarizeLineCount,
} from "../coreui/tools.js";
import type { ExecuteToolDetails } from "./executor-adapter.js";
import {
  EXECUTE_STREAM_TAIL_LINES,
  EXECUTE_SUMMARY_LINE_LIMIT,
  isExecuteRenderState,
  type ExecuteRenderState,
  type ExecuteToolInput,
  type ExecutorRenderTheme,
} from "./tools-shared.js";
import { sanitizeDisplayText } from "./tools-text.js";
import { highlightCode } from "@mariozechner/pi-coding-agent";

const trimTrailingEmptyLines = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
};

export const shouldDisplayDuration = (durationMs: number | undefined): durationMs is number =>
  typeof durationMs === "number" && durationMs >= 1000;

const limitLabelLength = (value: string, maxLength = EXECUTE_SUMMARY_LINE_LIMIT): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const summarizeCodeSnippet = (code: string): string => {
  const firstMeaningfulLine = code
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstMeaningfulLine === undefined) {
    return "Executor script";
  }

  return limitLabelLength(firstMeaningfulLine);
};

const readExecuteLabel = (args: Partial<ExecuteToolInput> | undefined): string => {
  const description =
    typeof args?.description === "string" && args.description.trim().length > 0
      ? args.description.trim()
      : undefined;
  if (description !== undefined && description.length > 0) {
    return limitLabelLength(description);
  }

  return summarizeCodeSnippet(typeof args?.code === "string" ? args.code : "");
};

export const readCode = (args: Partial<ExecuteToolInput> | undefined): string =>
  typeof args?.code === "string" ? args.code : "";

export const readDuration = (
  details: ExecuteToolDetails | undefined,
  state: ExecuteRenderState,
): number | undefined => {
  if (typeof details?.durationMs === "number") {
    return details.durationMs;
  }

  if (state.startedAt === undefined) {
    return undefined;
  }

  return (state.endedAt ?? Date.now()) - state.startedAt;
};

export const syncExecuteRenderState = (
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): ExecuteRenderState => {
  const state = isExecuteRenderState(context.state) ? context.state : {};

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  if (state.startedAt !== undefined && isPartial && state.interval === undefined) {
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
};

export const setExecuteCallComponent = (
  state: ExecuteRenderState,
  lastComponent: unknown,
  text: string,
): Text => {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
};

export const appendCollapsedExecuteSummary = (state: ExecuteRenderState, suffix: string): void => {
  if (
    !(state.callComponent instanceof Text) ||
    state.callText === undefined ||
    state.callText.length === 0 ||
    suffix.length === 0
  ) {
    return;
  }

  state.callComponent.setText(`${state.callText}${suffix}`);
};

export const renderHighlightedLines = (source: string, language: string): string[] =>
  trimTrailingEmptyLines(highlightCode(sanitizeDisplayText(source), language));

export const formatCollapsedCodePreview = (
  lines: string[],
  footer: string,
  theme: ExecutorRenderTheme,
): string => {
  const visibleLines = lines.slice(-EXECUTE_STREAM_TAIL_LINES);
  const earlierLineCount = Math.max(lines.length - visibleLines.length, 0);
  const blocks: string[] = [];

  if (earlierLineCount > 0) {
    blocks.push(
      `${theme.fg("dim", "↳ ")}${theme.fg("muted", `... (${earlierLineCount} earlier lines)`)}`,
    );
  }

  if (visibleLines.length > 0) {
    blocks.push(visibleLines.join("\n"));
  }

  blocks.push(`${theme.fg("dim", "↳ ")}${theme.fg("muted", footer)}`);
  return blocks.join("\n");
};

export const formatExecuteCallHeader = (
  args: Partial<ExecuteToolInput> | undefined,
  theme: ExecutorRenderTheme,
  phase: "pending" | "success" | "error",
): string => {
  let status = theme.italic(theme.fg("muted", "executing"));
  if (phase === "error") {
    status = theme.bold(theme.fg("error", "execute"));
  } else if (phase === "success") {
    status = theme.bold(theme.fg("muted", "executed"));
  }
  const label = readExecuteLabel(args);
  const lineCount = countTextLines(readCode(args));
  const suffix = lineCount > 0 ? theme.fg("muted", ` · ${summarizeLineCount(lineCount)}`) : "";
  return `${status} ${theme.fg("text", label)}${suffix}`;
};

export const resolveStatusColor = (
  status: string | undefined,
  theme: ExecutorRenderTheme,
  isError: boolean,
): ((text: string) => string) => {
  if (isError) {
    return (text) => theme.fg("error", text);
  }

  const normalized = status?.toLowerCase().trim();
  if (normalized === undefined || normalized.length === 0) {
    return (text) => theme.fg("muted", text);
  }

  if (
    ["completed", "complete", "success", "succeeded", "done", "ok", "accepted"].includes(normalized)
  ) {
    return (text) => theme.fg("success", text);
  }

  if (
    ["executing", "running", "waiting", "waiting for interaction", "pending", "paused"].includes(
      normalized,
    )
  ) {
    return (text) => theme.fg("warning", text);
  }

  if (["failed", "error", "cancelled", "declined"].includes(normalized)) {
    return (text) => theme.fg("error", text);
  }

  return (text) => theme.fg("muted", text);
};

export const formatDurationSummary = (durationMs: number): string =>
  `took ${formatDurationHuman(durationMs)}`;
