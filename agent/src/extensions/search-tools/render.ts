import { Text } from "@earendil-works/pi-tui";
import {
  createTextComponent,
  formatToolRail,
  getTextContent,
  renderToolError,
  type CoreUIToolTheme,
} from "../coreui/tools.js";
import { formatToolStatus } from "../coreui/tools-status.js";
import { parseSearchToolsResultDetails, type SearchToolsResultDetails } from "./types.js";

interface SearchToolsRenderState {
  callComponent?: Text;
}

interface SearchToolsRenderContext {
  state?: SearchToolsRenderState;
  lastComponent: unknown;
  isPartial: boolean;
  isError: boolean;
}

const MAX_QUERY_DISPLAY_LENGTH = 90;

function truncateQuery(query: string): string {
  if (query.length <= MAX_QUERY_DISPLAY_LENGTH) return query;
  return `${query.slice(0, MAX_QUERY_DISPLAY_LENGTH - 1)}…`;
}

function formatQuery(args: { query?: unknown }): string {
  if (typeof args.query !== "string" || args.query.trim().length === 0) return "…";
  return truncateQuery(args.query.trim());
}

function updateCallComponent(state: SearchToolsRenderState | undefined, text: string): void {
  state?.callComponent?.setText(text);
}

function outcomeLabel(details: SearchToolsResultDetails): string {
  if (details.added.length > 0) return `loaded ${details.added.join(", ")}`;
  if (details.alreadyActive.length > 0) return `matched ${details.alreadyActive.join(", ")}`;
  if (details.decision === "ambiguous") return "found ambiguous matches";
  return "found no matching tools";
}

function formatCollapsedCall(
  details: SearchToolsResultDetails,
  theme: CoreUIToolTheme,
  context: SearchToolsRenderContext,
): string {
  const rail = formatToolRail(theme, context);
  const query = theme.fg("muted", truncateQuery(details.query));
  const confidence = details.candidates[0]?.confidence;
  const score = confidence === undefined ? "" : ` · ${Math.round(confidence * 100)}%`;
  return `${rail}${theme.bold(theme.fg("muted", outcomeLabel(details)))} ${query}${theme.fg("dim", score)}`;
}

function formatCandidateKind(details: SearchToolsResultDetails, index: number): string {
  const candidate = details.candidates[index];
  if (candidate === undefined) return "";
  const matchedText = candidate.matchedText === undefined ? "" : `: ${candidate.matchedText}`;
  return `${candidate.kind.replaceAll("_", " ")}${matchedText}`;
}

function formatCandidateLine(
  details: SearchToolsResultDetails,
  index: number,
  theme: CoreUIToolTheme,
): string {
  const candidate = details.candidates[index];
  if (candidate === undefined) return "";
  const selected = details.matches.includes(candidate.name);
  const loaded = details.added.includes(candidate.name);
  const marker = selected ? theme.fg("success", loaded ? "+" : "=") : theme.fg("dim", "·");
  const name = selected ? theme.fg("accent", candidate.name) : theme.fg("text", candidate.name);
  const score = theme.fg("muted", `${Math.round(candidate.confidence * 100)}%`.padStart(4));
  const kind = theme.fg("dim", formatCandidateKind(details, index));
  return `${theme.fg("borderMuted", "▏")} ${marker} ${score} ${name} ${kind}`;
}

function formatExpandedResult(details: SearchToolsResultDetails, theme: CoreUIToolTheme): string {
  const lines = details.candidates.map((_, index) => formatCandidateLine(details, index, theme));
  const decision = [
    details.decision.replaceAll("_", " "),
    `threshold ${Math.round(details.minimumConfidence * 100)}%`,
    `margin ${Math.round(details.minimumWinnerMargin * 100)}%`,
  ].join(" · ");
  lines.push(`${theme.fg("borderMuted", "▏")} ${theme.fg("dim", decision)}`);
  return lines.join("\n");
}

export function renderSearchToolsCall(
  args: { query?: unknown },
  theme: CoreUIToolTheme,
  context: SearchToolsRenderContext,
): Text {
  const state = context.state ?? {};
  const status = formatToolStatus(theme, context, {
    pending: "searching tools",
    success: "searched tools",
    error: "tool search failed",
  });
  const text = `${formatToolRail(theme, context)}${status} ${theme.fg("muted", formatQuery(args))}`;
  const component = createTextComponent(state.callComponent ?? context.lastComponent, text);
  state.callComponent = component;
  return component;
}

export function renderSearchToolsResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: CoreUIToolTheme,
  context: SearchToolsRenderContext,
): Text {
  if (context.isError) {
    if (options.expanded !== true) return createTextComponent(context.lastComponent, "");
    return renderToolError(getTextContent(result), theme, context.lastComponent);
  }
  if (options.isPartial === true) return createTextComponent(context.lastComponent, "");

  const details = parseSearchToolsResultDetails(result.details);
  if (details === undefined) {
    return options.expanded === true
      ? createTextComponent(context.lastComponent, getTextContent(result))
      : createTextComponent(context.lastComponent, "");
  }
  updateCallComponent(context.state, formatCollapsedCall(details, theme, context));
  if (options.expanded !== true) return createTextComponent(context.lastComponent, "");
  return createTextComponent(context.lastComponent, formatExpandedResult(details, theme));
}
