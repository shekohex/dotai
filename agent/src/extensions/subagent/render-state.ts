import type { AgentToolResult, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  applyLinePrefix,
  countTextLines,
  createTextComponent,
  formatDurationHuman,
  formatToolRail,
  getTextContent,
  renderStreamingPreview,
  styleToolOutput,
  summarizeLineCount,
} from "../coreui/tools.js";
import type {
  SubagentToolParams,
  SubagentToolProgressDetails,
  SubagentToolResultDetails,
} from "../../subagent-sdk/types.js";
import {
  isSubagentRenderState,
  SUBAGENT_STREAM_PREVIEW_LINE_LIMIT,
  SUBAGENT_STREAM_PREVIEW_WIDTH,
  type SubagentRenderState,
} from "./shared.js";
import {
  formatCollapsedCallText,
  formatCollapsedResultSummary,
  formatExpandedCallText,
  formatExpandedResult,
} from "./render-format.js";
import {
  isProgressDetails,
  isSubagentToolRenderDetails,
  isSubagentToolResultDetails,
} from "./render-details.js";

type SubagentRenderCallContext = {
  expanded: boolean;
  lastComponent: Text | undefined;
  isError: boolean;
  isPartial: boolean;
  state: unknown;
};

type SubagentRenderResultContext = {
  args: SubagentToolParams;
  lastComponent: Text | undefined;
  isError: boolean;
  isPartial: boolean;
  state: unknown;
  executionStarted: boolean;
  invalidate: () => void;
};

function isSubagentRenderCallContext(value: unknown): value is SubagentRenderCallContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const expanded: unknown = Reflect.get(value, "expanded");
  const isError: unknown = Reflect.get(value, "isError");
  const isPartial: unknown = Reflect.get(value, "isPartial");
  return (
    typeof expanded === "boolean" &&
    typeof isError === "boolean" &&
    typeof isPartial === "boolean" &&
    Reflect.has(value, "state")
  );
}

function isSubagentRenderResultContext(value: unknown): value is SubagentRenderResultContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const isError: unknown = Reflect.get(value, "isError");
  const isPartial: unknown = Reflect.get(value, "isPartial");
  const executionStarted: unknown = Reflect.get(value, "executionStarted");
  const invalidate: unknown = Reflect.get(value, "invalidate");
  return (
    typeof isError === "boolean" &&
    typeof isPartial === "boolean" &&
    typeof executionStarted === "boolean" &&
    typeof invalidate === "function" &&
    Reflect.has(value, "state") &&
    Reflect.has(value, "args")
  );
}

function syncRenderState(context: { state: unknown }): SubagentRenderState {
  return isSubagentRenderState(context.state) ? context.state : {};
}

function syncStreamingRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): SubagentRenderState {
  const state = isSubagentRenderState(context.state) ? context.state : {};
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

function getElapsedMs(state: SubagentRenderState): number | undefined {
  return state.startedAt === undefined
    ? undefined
    : (state.endedAt ?? Date.now()) - state.startedAt;
}

function setCallComponent(state: SubagentRenderState, lastComponent: unknown, text: string): Text {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
}

function applyCollapsedSummaryToCall(state: SubagentRenderState, summary: string): void {
  if (
    !(state.callComponent instanceof Text) ||
    state.callText === undefined ||
    state.callText.length === 0 ||
    summary.length === 0
  ) {
    return;
  }

  const lines = state.callText.split("\n");
  lines[0] = `${lines[0] ?? ""}${summary}`;
  state.callComponent.setText(lines.join("\n"));
}

function formatProgressPhase(details: SubagentToolProgressDetails): string {
  if (details.phase === "handoff") {
    return "handoff";
  }
  if (details.phase === "launch") {
    return "launching";
  }
  if (details.delivery) {
    return `${details.phase} ${details.delivery}`;
  }
  return details.phase;
}

function formatProgressFooter(
  details: SubagentToolProgressDetails | undefined,
  previewText: string,
  expanded: boolean,
  elapsedMs?: number,
): string {
  const phase = details ? formatProgressPhase(details) : "working";
  const duration = formatDurationHuman(elapsedMs ?? 0);
  if (expanded) {
    return `${phase} · ${duration}`;
  }
  return `${summarizeLineCount(countTextLines(previewText))} so far (${duration}) · ${phase}`;
}

function renderPartialSubagentResult(
  args: SubagentToolParams,
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  expanded: boolean,
  theme: Theme,
  context: { lastComponent: unknown },
  state: SubagentRenderState,
  rail: string,
): Text {
  const details = isSubagentToolRenderDetails(result.details) ? result.details : undefined;
  const progress = isProgressDetails(details) ? details : undefined;
  const previewText = (progress?.preview ?? getTextContent(result) ?? "").trim();
  const elapsedMs = progress?.durationMs ?? getElapsedMs(state);

  applyCollapsedSummaryToCall(
    state,
    `${theme.fg("dim", " · ")}${progress ? theme.fg("muted", formatProgressPhase(progress)) : theme.fg("muted", "...")}`,
  );

  if (!previewText) {
    const label = progress?.statusText ?? `${args.action} in progress`;
    const duration = formatDurationHuman(elapsedMs ?? 0);
    return createTextComponent(
      context.lastComponent,
      `${rail}${theme.fg("dim", "↳ ")}${theme.fg("muted", `${label} (${duration})`)}`,
    );
  }

  return renderStreamingPreview(
    applyLinePrefix(
      styleToolOutput(previewText, theme, SUBAGENT_STREAM_PREVIEW_WIDTH, { truncateFrom: "tail" }),
      rail,
    ),
    theme,
    context.lastComponent,
    {
      expanded,
      footer: formatProgressFooter(progress, previewText, expanded, elapsedMs),
      tailLines: SUBAGENT_STREAM_PREVIEW_LINE_LIMIT,
    },
  );
}

function renderSubagentToolCall(args: SubagentToolParams, theme: Theme, context: unknown) {
  if (!isSubagentRenderCallContext(context)) {
    throw new Error("Invalid subagent tool call render context");
  }
  const typedContext = context;
  const state = syncRenderState(typedContext);
  const rail = formatToolRail(theme, typedContext);
  const callText = typedContext.expanded
    ? formatExpandedCallText(args, theme)
    : formatCollapsedCallText(args, theme);
  return setCallComponent(state, typedContext.lastComponent, applyLinePrefix(callText, rail));
}

function renderSubagentToolResult(
  result: AgentToolResult<SubagentToolResultDetails>,
  renderOptions: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: unknown,
) {
  if (!isSubagentRenderResultContext(context)) {
    throw new Error("Invalid subagent tool result render context");
  }
  const typedContext = context;
  const renderState = syncStreamingRenderState(typedContext, renderOptions.isPartial);
  const rail = formatToolRail(theme, typedContext);
  const separator = theme.fg("dim", " · ");
  const details =
    result.details !== null && typeof result.details === "object" ? result.details : undefined;
  if (typedContext.isError) {
    applyCollapsedSummaryToCall(renderState, `${separator}${theme.fg("error", "error")}`);
    return createTextComponent(
      typedContext.lastComponent,
      `${rail}${theme.fg("error", "↳ ")}${theme.fg("error", getTextContent(result) || "subagent failed")}`,
    );
  }
  if (renderOptions.isPartial) {
    return renderPartialSubagentResult(
      typedContext.args,
      result,
      renderOptions.expanded,
      theme,
      typedContext,
      renderState,
      rail,
    );
  }
  applyCollapsedSummaryToCall(
    renderState,
    `${separator}${formatCollapsedResultSummary(isSubagentToolResultDetails(details) ? details : undefined, theme)}`,
  );
  if (!renderOptions.expanded) {
    return createTextComponent(typedContext.lastComponent, "");
  }
  return createTextComponent(
    typedContext.lastComponent,
    applyLinePrefix(
      formatExpandedResult(isSubagentToolResultDetails(details) ? details : undefined),
      rail,
    ),
  );
}

export { renderSubagentToolCall, renderSubagentToolResult };
