import { Text } from "@earendil-works/pi-tui";
import {
  createTextComponent,
  formatToolRail,
  getTextContent,
  renderStreamingPreview,
  styleToolOutput,
  type CoreUIToolTheme,
} from "../coreui/tools.js";
import { shortenPathForTool } from "../coreui/path.js";
import { formatToolStatus } from "../coreui/tools-status.js";
import { STREAMING_PREVIEW_LINES, TOOL_OUTPUT_LINE_LIMIT } from "./constants.js";
import type { SearchRenderContext, SearchRenderState, SearchToolDetails } from "./types.js";

const MAX_QUERY_DISPLAY_LENGTH = 80;
const MAX_PATH_DISPLAY_LENGTH = 80;

function formatElapsedDuration(elapsedMs: number | undefined): string {
  if (elapsedMs === undefined || elapsedMs <= 0) return "";
  if (elapsedMs < 1) return ` took ${Math.max(1, Math.round(elapsedMs * 1000))}µs`;
  if (elapsedMs < 1000) return ` took ${Math.round(elapsedMs)}ms`;
  if (elapsedMs < 60_000) return ` took ${(elapsedMs / 1000).toFixed(1).replaceAll(/\.0$/g, "")}s`;
  return ` took ${(elapsedMs / 60_000).toFixed(1).replaceAll(/\.0$/g, "")}min`;
}

function formatMatchSummary(details: SearchToolDetails | undefined): string {
  const matches = details?.totalMatched ?? 0;
  const files = details?.totalFiles ?? 0;
  return `${matches} match${matches === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`;
}

function getSearchElapsed(state: SearchRenderState | undefined): number | undefined {
  if (state?.startedAt === undefined) return undefined;
  return Date.now() - state.startedAt;
}

function getSearchVerbs(tool: "grep" | "find") {
  if (tool === "grep") {
    return { pending: "searching", success: "searched", error: "search failed" };
  }

  return { pending: "finding", success: "found", error: "find failed" };
}

function trimMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…";

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

function formatSearchSubject(input: {
  tool: "grep" | "find";
  pattern: string;
  path: string;
  cwd: string;
  theme: CoreUIToolTheme;
}): string {
  const query = input.tool === "grep" ? `/${input.pattern}/` : input.pattern;
  const path = trimMiddle(shortenPathForTool(input.path, input.cwd), MAX_PATH_DISPLAY_LENGTH);
  return `${input.theme.fg("text", `${trimMiddle(query, MAX_QUERY_DISPLAY_LENGTH)} in `)}${input.theme.fg("muted", path)}`;
}

function formatSearchCall(input: {
  tool: "grep" | "find";
  args: { pattern?: unknown; path?: unknown };
  theme: CoreUIToolTheme;
  context: { cwd: string; isPartial: boolean; isError: boolean };
  state?: SearchRenderState;
}): string {
  const pattern = typeof input.args.pattern === "string" ? input.args.pattern : "";
  const path =
    typeof input.args.path === "string" && input.args.path.length > 0 ? input.args.path : ".";
  const status = formatToolStatus(input.theme, input.context, getSearchVerbs(input.tool));
  const subject = formatSearchSubject({
    tool: input.tool,
    pattern,
    path,
    cwd: input.context.cwd,
    theme: input.theme,
  });
  const elapsed = input.context.isPartial
    ? formatElapsedDuration(getSearchElapsed(input.state))
    : "";
  return `${formatToolRail(input.theme, input.context)}${status} ${subject}${elapsed}`;
}

function setSearchCallComponent(
  state: SearchRenderState,
  lastComponent: unknown,
  text: string,
): Text {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
}

function styleSearchOutput(output: string, theme: CoreUIToolTheme): string {
  return styleToolOutput(output, theme, TOOL_OUTPUT_LINE_LIMIT);
}

function applySearchSummaryToCall(
  state: SearchRenderState | undefined,
  result: { details?: SearchToolDetails },
  theme: CoreUIToolTheme,
): void {
  if (!(state?.callComponent instanceof Text) || state.callText === undefined) return;
  const baseCallText = state.baseCallText ?? state.callText;
  state.callComponent.setText(
    `${baseCallText} · ${theme.fg("muted", formatMatchSummary(result.details))}${theme.fg(
      "dim",
      formatElapsedDuration(result.details?.elapsedMs),
    )}`,
  );
}

function formatSearchFooter(
  details: SearchToolDetails | undefined,
  theme: CoreUIToolTheme,
): string {
  const summary = formatMatchSummary(details);
  const elapsed = formatElapsedDuration(details?.elapsedMs).trimStart();
  if (elapsed.length === 0) return summary;
  return `${summary} ${theme.fg("dim", elapsed)}`;
}

export function renderSearchCall(
  tool: "grep" | "find",
  args: { pattern?: unknown; path?: unknown },
  theme: CoreUIToolTheme,
  context: SearchRenderContext,
): Text {
  const state = context.state ?? {};
  if (context.isPartial && state.startedAt === undefined) state.startedAt = Date.now();
  const text = formatSearchCall({ tool, args, theme, context, state });
  state.baseCallText = formatSearchCall({
    tool,
    args,
    theme,
    context: { ...context, isPartial: false, isError: false },
    state,
  });
  return setSearchCallComponent(state, context.lastComponent, text);
}

export function renderSearchResult(
  result: { content: { type: string; text?: string }[]; details?: SearchToolDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: CoreUIToolTheme,
  context: SearchRenderContext,
): Text {
  const output = getTextContent(result).trim();

  if (options.isPartial === true) {
    return renderStreamingPreview(styleSearchOutput(output, theme), theme, context.lastComponent, {
      expanded: options.expanded === true,
      tailLines: STREAMING_PREVIEW_LINES,
    });
  }

  if (options.expanded !== true || output.length === 0) {
    applySearchSummaryToCall(context.state, result, theme);
    return createTextComponent(context.lastComponent, "");
  }

  return renderStreamingPreview(styleSearchOutput(output, theme), theme, context.lastComponent, {
    expanded: true,
    footer: formatSearchFooter(result.details, theme),
  });
}

export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}
