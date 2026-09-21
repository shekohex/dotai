import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CoreUIToolTheme } from "../../coreui/tools.js";
import {
  createTextComponent,
  formatToolRail,
  getTextContent,
  renderStreamingPreview,
  renderToolError,
  styleToolOutput,
} from "../../coreui/tools.js";
import { formatToolStatus } from "../../coreui/tools-status.js";
import type {
  ObservationDetails,
  RecallObservationToolDetails,
  RecallObservationToolStatus,
  RecallSourceEntryDetails,
  ReflectionDetails,
} from "./recall-observation.js";

/**
 * Whether a recall only produced direct observation matches (no reflections).
 *
 * @param {RecallObservationToolDetails} details Tool result details.
 * @returns {boolean} Whether reflection support is absent.
 */
function isObservationOnly(details: RecallObservationToolDetails): boolean {
  return details.reflections.length === 0 && details.unavailableSupportingObservations.length === 0;
}

const RECALL_OUTPUT_LINE_LIMIT = 80;

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

function sourceEntriesFromDetails(
  details: RecallObservationToolDetails,
): RecallSourceEntryDetails[] {
  if (!isObservationOnly(details)) return details.sourceEntries;
  return details.matches.flatMap((match) => match.sourceEntries ?? []);
}

function tokenSummary(tokens: number): string {
  return `~${tokens.toLocaleString()} ${tokens === 1 ? "token" : "tokens"}`;
}

function isFailureStatus(status: RecallObservationToolStatus): boolean {
  return status === "invalid_id" || status === "not_found";
}

function observationCountForHeader(details: RecallObservationToolDetails): number {
  return isObservationOnly(details) ? details.matches.length : details.observations.length;
}

const TUI_TYPE_WIDTH = 15;
const TUI_META_WIDTH = 31;

function alignedRow(type: string, meta: string, text: string): string {
  return `${type.padEnd(TUI_TYPE_WIDTH)} ${meta.padEnd(TUI_META_WIDTH)} ${text}`.trimEnd();
}

function sourceTag(source: RecallSourceEntryDetails): string {
  const origin = source.origin.trim().toLowerCase();
  if (origin === "user") return "user";
  if (origin === "assistant") return "assistant";
  if (origin.startsWith("tool result")) return "tool";
  if (origin.startsWith("custom message")) return "custom";
  if (origin.startsWith("branch summary")) return "summary";
  return origin.split(/[^a-z0-9]+/).find(Boolean) ?? "entry";
}

function sourceMetadataLine(source: RecallSourceEntryDetails): string {
  return alignedRow(
    "✓ source",
    `${source.timestamp} [${sourceTag(source)}]`,
    tokenSummary(source.tokens),
  );
}

function observationLine(observation: ObservationDetails): string {
  const status = observation.status === "dropped" ? " dropped" : "";
  return alignedRow(
    "✓ observation",
    `${observation.timestamp} [${observation.relevance}]${status}`,
    observation.content,
  );
}

function reflectionLine(reflection: ReflectionDetails): string {
  return alignedRow("✓ reflection", "", reflection.content);
}

function noteLine(kind: string, text: string): string {
  return alignedRow("• note", `[${kind}]`, text);
}

function indentContent(content: string): string {
  return content
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function unavailableEvidenceMessage(_details: RecallObservationToolDetails): string {
  return "no source entries are available for this memory id";
}

function pushSourceLines(
  lines: string[],
  sources: RecallSourceEntryDetails[],
  expanded: boolean,
): void {
  for (const source of sources) {
    lines.push(sourceMetadataLine(source));
    const content = source.content;
    if (expanded && content !== undefined && content.length > 0) {
      lines.push(indentContent(content));
      lines.push("");
    }
  }
}

function memoryRows(details: RecallObservationToolDetails): string[] {
  if (isObservationOnly(details))
    return details.matches.map((match) => observationLine(match.observation));
  return [
    ...details.reflections.map((reflection) => reflectionLine(reflection)),
    ...details.observations.map((observation) => observationLine(observation.observation)),
  ];
}

function noteRows(
  details: RecallObservationToolDetails,
  sources: RecallSourceEntryDetails[],
): string[] {
  const notes: string[] = [];
  if (details.status === "invalid_id") {
    notes.push(
      noteLine(
        "invalid id",
        `memory ids must be 12 lowercase hex characters; received ${details.memoryId}`,
      ),
    );
    return notes;
  }
  if (details.status === "not_found") {
    notes.push(
      noteLine(
        "not found",
        `no observation or reflection with id ${details.memoryId} was found on the current branch`,
      ),
    );
    return notes;
  }
  if (details.collision)
    notes.push(noteLine("id collision", `multiple memory items share ${details.memoryId}`));
  if (details.observations.some((match) => match.observation.status === "dropped"))
    notes.push(
      noteLine(
        "dropped",
        "one or more observations are dropped from active memory but remain recallable",
      ),
    );
  if (details.unavailableSupportingObservations.length > 0)
    notes.push(
      noteLine(
        "missing support",
        details.unavailableSupportingObservations.map((item) => item.observationId).join(", "),
      ),
    );
  if (details.missingSourceEntryIds.length > 0)
    notes.push(noteLine("missing source", details.missingSourceEntryIds.join(", ")));
  if (details.nonSourceEntryIds.length > 0)
    notes.push(noteLine("non-source", details.nonSourceEntryIds.join(", ")));
  if (
    sources.length === 0 &&
    (details.reflections.length > 0 ||
      details.observations.length > 0 ||
      details.matches.length > 0)
  )
    notes.push(noteLine("unavailable evidence", unavailableEvidenceMessage(details)));
  return notes;
}

export function formatRecallResultForTui(
  result: AgentToolResult<RecallObservationToolDetails>,
  expanded: boolean,
): string {
  const details = result.details;
  if (details === undefined) {
    const text = result.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n");
    return text || "recall";
  }
  const sources = sourceEntriesFromDetails(details);
  const lines: string[] = [];
  const rows = memoryRows(details);
  const notes = noteRows(details, sources);
  lines.push(...rows);
  if (rows.length > 0 && notes.length > 0) lines.push("");
  lines.push(...notes);
  if ((rows.length > 0 || notes.length > 0) && sources.length > 0) lines.push("");
  pushSourceLines(lines, sources, expanded);
  return lines.join("\n").trimEnd();
}

/** Structural render context handed to recall call/result renderers. */
export type RecallToolRenderContext = {
  args: { id?: unknown; ids?: unknown };
  state: RecallRenderState;
  lastComponent: unknown;
  isPartial: boolean;
  isError: boolean;
};

/** Shared renderer state for one recall tool row (call line rewriting). */
export type RecallRenderState = {
  callComponent?: unknown;
  baseCallText?: string;
};

/**
 * Fold the recall outcome into the stored call line: `recalled <ids> · 1 observation · ...`.
 *
 * @param {RecallRenderState} state Shared renderer state for this tool row.
 * @param {string} summary Compact counts summary.
 * @param {CoreUIToolTheme} theme Active tool theme.
 * @returns {boolean} Whether the call line was updated.
 */
export function applyRecallSummaryToCall(
  state: RecallRenderState,
  summary: string,
  theme: CoreUIToolTheme,
): boolean {
  if (!(state.callComponent instanceof Text)) return false;
  if (state.baseCallText === undefined || state.baseCallText.length === 0) return false;
  state.callComponent.setText(`${state.baseCallText}${theme.fg("muted", ` · ${summary}`)}`);
  return true;
}

/**
 * Render the ids portion of the call line, collapsing long batches.
 *
 * @param {{ id?: unknown; ids?: unknown }} args Tool call arguments.
 * @returns {string} Display subject.
 */
export function formatRecallSubject(args: { id?: unknown; ids?: unknown }): string {
  if (typeof args.id === "string" && args.id.length > 0) return args.id;
  if (Array.isArray(args.ids)) {
    const ids = args.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 1) return ids[0] ?? "...";
    if (ids.length === 2) return ids.join(", ");
    if (ids.length > 2) return `${ids[0]} +${ids.length - 1} more`;
  }
  return "...";
}

/**
 * Counts summary parts shared by single and batch recalls.
 *
 * @param {RecallObservationToolDetails} details Details to count.
 * @returns {string[]} Non-empty `a · b · c` parts.
 */
function summaryPartsForDetails(details: RecallObservationToolDetails): string[] {
  const parts: string[] = [];
  if (details.reflections.length > 0) parts.push(plural(details.reflections.length, "reflection"));
  const observations = observationCountForHeader(details);
  if (observations > 0) parts.push(plural(observations, "observation"));
  const sources = sourceEntriesFromDetails(details);
  if (sources.length > 0) parts.push(plural(sources.length, "source"));
  const tokens = sources.reduce((sum, source) => sum + source.tokens, 0);
  if (tokens > 0) parts.push(tokenSummary(tokens));
  if (details.partial && details.status !== "ok") parts.push(details.status.replaceAll("_", " "));
  return parts;
}

/**
 * Searchable summary line for the call row: `1 observation · 1 source · ~38 tokens`.
 *
 * @param {RecallObservationToolDetails | undefined} details Tool result details, when present.
 * @param {string} fallback Text used when details are missing entirely.
 * @returns {string} Compact `a · b · c` summary.
 */
export function formatRecallSummaryForTui(
  details: RecallObservationToolDetails | undefined,
  fallback: string,
): string {
  if (details === undefined) return fallback;
  if (isFailureStatus(details.status)) {
    return details.status === "not_found" ? "not found" : "invalid id";
  }
  const batch = details.batchResults ?? [];
  const parts =
    batch.length > 0
      ? summaryPartsForDetails({
          ...details,
          reflections: batch.flatMap((entry) => entry.reflections),
          observations: batch.flatMap((entry) => entry.observations),
          matches: batch.flatMap((entry) => entry.matches),
          sourceEntries: batch.flatMap((entry) => entry.sourceEntries),
          unavailableSupportingObservations: batch.flatMap(
            (entry) => entry.unavailableSupportingObservations,
          ),
          partial: batch.some((entry) => entry.partial),
        })
      : summaryPartsForDetails(details);
  const notFound = batch.filter((entry) => entry.status === "not_found").length;
  if (notFound > 0) parts.push(`${notFound} not found`);
  if (parts.length === 0) return "no evidence";
  return parts.join(" · ");
}

export const RECALL_VERBS = {
  pending: "recalling",
  success: "recalled",
  error: "recall failed",
} as const;

export function renderRecallCall(
  args: { id?: unknown; ids?: unknown },
  theme: CoreUIToolTheme,
  context: RecallToolRenderContext,
): Text {
  const state = context.state;
  const rail = formatToolRail(theme, context);
  const status = formatToolStatus(theme, context, RECALL_VERBS);
  const subject = formatRecallSubject(args);
  const text = `${rail}${status} ${theme.fg("muted", subject)}`;
  const component = createTextComponent(context.lastComponent, text);
  state.callComponent = component;
  if (!context.isError) {
    const successStatus = formatToolStatus(theme, { ...context, isPartial: false }, RECALL_VERBS);
    state.baseCallText = `${rail}${successStatus} ${theme.fg("muted", subject)}`;
  }
  return component;
}

export function renderRecallResult(
  result: AgentToolResult<RecallObservationToolDetails>,
  options: { expanded?: boolean },
  theme: CoreUIToolTheme,
  context: RecallToolRenderContext,
): Text {
  const { expanded = false } = options;
  const state = context.state;
  if (context.isError) {
    if (!expanded) return createTextComponent(context.lastComponent, "");
    const output = getTextContent(result).trim() || "recall failed";
    return renderToolError(output, theme, context.lastComponent);
  }
  const summary = formatRecallSummaryForTui(
    result.details,
    getTextContent(result).trim() || "recalled",
  );
  if (!expanded) {
    if (applyRecallSummaryToCall(state, summary, theme)) {
      return createTextComponent(context.lastComponent, "");
    }
    const rail = formatToolRail(theme, context);
    const status = formatToolStatus(theme, context, RECALL_VERBS);
    const subject = formatRecallSubject(context.args);
    return createTextComponent(
      context.lastComponent,
      `${rail}${status} ${theme.fg("muted", subject)}${theme.fg("muted", ` · ${summary}`)}`,
    );
  }
  applyRecallSummaryToCall(state, summary, theme);
  const body = styleToolOutput(
    formatRecallResultForTui(result, true),
    theme,
    RECALL_OUTPUT_LINE_LIMIT,
  );
  return renderStreamingPreview(body, theme, context.lastComponent, {
    expanded: true,
    footer: summary,
  });
}
