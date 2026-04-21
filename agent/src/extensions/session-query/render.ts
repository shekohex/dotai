import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import {
  type CoreUIToolTheme,
  createTextComponent,
  formatDurationHuman,
  formatToolRail,
  getTextContent,
  renderStreamingPreview,
  styleToolOutput,
  summarizeLineCount,
} from "../coreui/tools.js";
import {
  applyCollapsedSummaryToCall,
  getElapsedMs,
  setCallComponent,
  syncRenderState,
  type SessionQueryRenderState,
} from "./render-state.js";
import {
  countRenderedLines,
  extractSessionUuid,
  parseSessionQueryToolDetails,
  truncateQuestion,
} from "./utils.js";

const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;
const STREAM_PREVIEW_LINE_LIMIT = 5;

export function renderSessionQueryCall(
  args: { sessionPath?: string; question?: string },
  theme: CoreUIToolTheme,
  context: {
    state: unknown;
    isPartial: boolean;
    isError: boolean;
    lastComponent: unknown;
    executionStarted: boolean;
    invalidate: () => void;
  },
): Text {
  const state = syncRenderState(context, context.isPartial);
  const rail = formatToolRail(theme, context);

  let phase: "error" | "pending" | "success" = "success";
  if (context.isError) {
    phase = "error";
  } else if (context.isPartial) {
    phase = "pending";
  }

  let status = theme.bold(theme.fg("dim", "queried"));
  if (phase === "error") {
    status = theme.bold(theme.fg("error", "queried"));
  } else if (phase === "pending") {
    status = theme.bold(theme.fg("dim", "querying"));
  }
  const sessionLabel = extractSessionUuid(args.sessionPath ?? "");
  const question =
    typeof args.question === "string" && args.question.trim().length > 0
      ? args.question.trim()
      : "...";

  const text = `${rail}${status} ${theme.fg("muted", sessionLabel)}${theme.fg("dim", " → ")}${theme.fg("muted", truncateQuestion(question))}`;
  return setCallComponent(state, context.lastComponent, text);
}

export function renderSessionQueryResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  renderState: { expanded: boolean; isPartial: boolean },
  theme: CoreUIToolTheme,
  context: {
    state: unknown;
    isPartial: boolean;
    isError: boolean;
    lastComponent: unknown;
    args?: { question?: string };
    executionStarted: boolean;
    invalidate: () => void;
  },
): Container | Text {
  const state = syncRenderState(context, renderState.isPartial);
  const rail = formatToolRail(theme, context);
  const textContent = getTextContent(result);
  const details = parseSessionQueryToolDetails(result.details);
  const elapsedMs = getElapsedMs(state);

  if (context.isError) {
    return renderSessionQueryError(
      renderState.expanded,
      context.lastComponent,
      rail,
      textContent,
      theme,
    );
  }

  return renderSessionQuerySuccess({
    expanded: renderState.expanded,
    isPartial: renderState.isPartial,
    lastComponent: context.lastComponent,
    rail,
    textContent,
    elapsedMs,
    details,
    fallbackQuestion: context.args?.question ?? "",
    state,
    theme,
  });
}

function renderSessionQuerySuccess(input: {
  expanded: boolean;
  isPartial: boolean;
  lastComponent: unknown;
  rail: string;
  textContent: string;
  elapsedMs: number | undefined;
  details: { question?: string } | undefined;
  fallbackQuestion: string;
  state: SessionQueryRenderState;
  theme: CoreUIToolTheme;
}): Container | Text {
  if (input.isPartial) {
    return renderSessionQueryPartial(
      input.expanded,
      input.lastComponent,
      input.rail,
      input.textContent,
      input.elapsedMs,
      input.theme,
    );
  }

  return renderSessionQueryComplete(
    input.expanded,
    input.lastComponent,
    input.rail,
    input.textContent,
    input.details,
    input.fallbackQuestion,
    input.elapsedMs,
    input.state,
    input.theme,
  );
}

function renderSessionQueryError(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  textContent: string,
  theme: CoreUIToolTheme,
): Text {
  if (!expanded) {
    return createTextComponent(lastComponent, "");
  }

  return createTextComponent(
    lastComponent,
    `${rail}${theme.fg("error", "↳ ")}${theme.fg("error", textContent || "Session query failed.")}`,
  );
}

function renderSessionQueryPartial(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  textContent: string,
  elapsedMs: number | undefined,
  theme: CoreUIToolTheme,
): Text {
  const renderedText = styleToolOutput(textContent, theme);
  const footer = elapsedMs === undefined ? "0s" : formatDurationHuman(elapsedMs);
  if (renderedText) {
    return renderStreamingPreview(renderedText, theme, lastComponent, {
      expanded,
      footer: expanded
        ? footer
        : `${summarizeLineCount(countRenderedLines(textContent))} so far (${footer})`,
      tailLines: STREAM_PREVIEW_LINE_LIMIT,
    });
  }

  return createTextComponent(
    lastComponent,
    `${rail}${theme.fg("dim", "↳ ")}${theme.fg("muted", `loading session (${footer})`)}`,
  );
}

function renderSessionQueryComplete(
  expanded: boolean,
  lastComponent: unknown,
  rail: string,
  answer: string,
  details: { question?: string } | undefined,
  fallbackQuestion: string,
  elapsedMs: number | undefined,
  state: SessionQueryRenderState,
  theme: CoreUIToolTheme,
): Container | Text {
  const summary = buildSessionQuerySummary(answer, elapsedMs, theme);
  if (!expanded) {
    applyCollapsedSummaryToCall(state, `${theme.fg("muted", " · ")}${summary}`);
    return createTextComponent(lastComponent, "");
  }

  const question = details?.question ?? fallbackQuestion;
  const container = lastComponent instanceof Container ? lastComponent : new Container();
  container.clear();
  container.addChild(
    new Text(
      `${rail}${theme.fg("muted", "Question:")} ${theme.fg("accent", question)}`,
      TOOL_TEXT_PADDING_X,
      TOOL_TEXT_PADDING_Y,
    ),
  );
  container.addChild(new Spacer(1));
  container.addChild(
    new Markdown(
      answer.trim() || "No answer returned.",
      TOOL_TEXT_PADDING_X,
      TOOL_TEXT_PADDING_Y,
      getMarkdownTheme(),
      {
        color: (text: string) => theme.fg("toolOutput", text),
      },
    ),
  );
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(`${rail}${theme.fg("dim", "↳ ")}${summary}`, TOOL_TEXT_PADDING_X, TOOL_TEXT_PADDING_Y),
  );
  return container;
}

function buildSessionQuerySummary(
  answer: string,
  elapsedMs: number | undefined,
  theme: CoreUIToolTheme,
): string {
  const summaryParts = [theme.fg("muted", answer ? "answered" : "no response")];
  if (elapsedMs !== undefined) {
    summaryParts.push(theme.fg("muted", `took ${formatDurationHuman(elapsedMs)}`));
  }
  return summaryParts.filter((part) => part.length > 0).join(theme.fg("muted", " · "));
}
