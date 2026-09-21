import { Type } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderRecallCall, renderRecallResult } from "./recall-render.js";
import { asRecord } from "../../../utils/unknown-data.js";

import {
  recallMemorySources,
  type Entry,
  type RecallResult,
  type RecalledObservation,
} from "../session-ledger/recall.js";
import type { Observation, Reflection } from "../session-ledger/index.js";
import { renderRecallSourceEntries, renderRecallSourceEntry } from "../serialize.js";
import { estimateEntryTokens } from "../tokens.js";

export const RECALL_OBSERVATION_TOOL_NAME = "recall";

const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

const MEMORY_ID_DESCRIPTION =
  "12-character lowercase hex observation or reflection id shown in compacted memory, /om view, or a previous recall result. Must be a specific id; this tool does not search by topic.";

const MAX_RECALL_IDS = 16;

export type RecallObservationToolStatus =
  | "ok"
  | "partial"
  | "invalid_id"
  | "not_found"
  | "no_source"
  | "source_unavailable";

export type ObservationDetails = Pick<Observation, "id" | "content" | "timestamp" | "relevance"> & {
  status?: "active" | "dropped";
};
export type ReflectionDetails = Pick<Reflection, "id" | "content" | "supportingObservationIds"> & {
  reflectionIndex: number;
};

export type RecallSourceEntryDetails = {
  id: string;
  origin: string;
  timestamp: string;
  tokens: number;
  qualifiers: string[];
  content?: string;
};

export type RecallObservationMatchDetails = {
  status: "active" | "dropped" | "source_unavailable" | "no_source";
  observationEntryId: string;
  observationRecordIndex: number;
  observation: ObservationDetails;
  sourceEntryIds?: string[];
  sourceEntries?: RecallSourceEntryDetails[];
  missingSourceEntryIds?: string[];
  nonSourceEntryIds?: string[];
  sourceCharacterCount?: number;
};

type RecallUnavailableSupportingObservationDetails = {
  observationId: string;
};

export type RecallObservationToolDetails = {
  status: RecallObservationToolStatus;
  memoryId: string;
  observationId: string;
  collision: boolean;
  partial: boolean;
  reflections: ReflectionDetails[];
  directObservationMatches: RecallObservationMatchDetails[];
  observations: RecallObservationMatchDetails[];
  matches: RecallObservationMatchDetails[];
  sourceEntries: RecallSourceEntryDetails[];
  unavailableSupportingObservations: RecallUnavailableSupportingObservationDetails[];
  missingSourceEntryIds: string[];
  nonSourceEntryIds: string[];
  sourceCharacterCount?: number;
  message?: string;
  /** Per-id details when a single call recalled a list of ids. */
  batchResults?: RecallObservationToolDetails[];
};

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDisplayTimestamp(...values: Array<number | string | undefined>): string {
  for (const v of values) {
    if (v === undefined) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return fmtLocal(d);
  }
  return "Unknown time";
}

function textContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items));
}

/**
 * Narrow a stored message payload to a pi LLM message.
 *
 * @param {unknown} value Stored message payload.
 * @returns {boolean} Whether the payload looks like an LLM message.
 */
function isRecallMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value;
}

function sourceOriginAndQualifiers(entry: Entry): {
  origin: string;
  timestamp: string;
  qualifiers: string[];
} {
  if (entry.type === "message" && isRecallMessage(entry.message)) {
    const msg: Message = entry.message;
    const timestamp = formatDisplayTimestamp(msg.timestamp, entry.timestamp);
    if (msg.role === "user") return { origin: "User", timestamp, qualifiers: [] };
    if (msg.role === "assistant") {
      const toolCalls = uniqueStrings(
        textContentBlocks(msg.content)
          .filter((block) => block.type === "toolCall" && typeof block.name === "string")
          .map((block) => (typeof block.name === "string" ? block.name : "")),
      );
      return {
        origin: "Assistant",
        timestamp,
        qualifiers: toolCalls.length > 0 ? [`tool calls: ${toolCalls.join(", ")}`] : [],
      };
    }
    const toolName = msg.role === "toolResult" ? msg.toolName : undefined;
    return {
      origin: `Tool result: ${toolName === undefined || toolName.length === 0 ? "unknown" : toolName}`,
      timestamp,
      qualifiers: [],
    };
  }
  if (entry.type === "custom_message") {
    return {
      origin: "Custom message",
      timestamp: formatDisplayTimestamp(entry.timestamp),
      qualifiers:
        typeof entry.customType === "string" && entry.customType
          ? [`custom: ${entry.customType}`]
          : [],
    };
  }
  if (entry.type === "branch_summary")
    return {
      origin: "Branch summary",
      timestamp: formatDisplayTimestamp(entry.timestamp),
      qualifiers: [],
    };
  return {
    origin: entry.type || "Entry",
    timestamp: formatDisplayTimestamp(entry.timestamp),
    qualifiers: [],
  };
}

function renderSourceEntryContentOnly(entry: Entry): string | undefined {
  const rendered = renderRecallSourceEntry(entry);
  return rendered?.replace(/^\[[^\]]+\]:\s?/, "") ?? undefined;
}

function sourceEntryDetails(entry: Entry, includeContent: boolean): RecallSourceEntryDetails {
  const { origin, timestamp, qualifiers } = sourceOriginAndQualifiers(entry);
  const content = renderSourceEntryContentOnly(entry);
  return {
    id: entry.id,
    origin,
    timestamp,
    tokens: estimateEntryTokens(entry),
    qualifiers,
    ...(includeContent && content !== undefined && content.length > 0 ? { content } : {}),
  };
}

function observationDetails(
  observation: Observation,
  status?: "active" | "dropped",
): ObservationDetails {
  return {
    id: observation.id,
    content: observation.content,
    timestamp: observation.timestamp,
    relevance: observation.relevance,
    ...(status ? { status } : {}),
  };
}

function reflectionDetails(reflection: Reflection, reflectionIndex: number): ReflectionDetails {
  return {
    id: reflection.id,
    content: reflection.content,
    supportingObservationIds: reflection.supportingObservationIds,
    reflectionIndex,
  };
}

function observationMatchDetails(
  match: RecalledObservation,
  includeSourceContent = true,
): RecallObservationMatchDetails {
  const unavailable = match.missingSourceEntryIds.length > 0 || match.nonSourceEntryIds.length > 0;
  let status: RecallObservationMatchDetails["status"];
  if (unavailable) status = "source_unavailable";
  else if (match.sourceEntries.length === 0) status = "no_source";
  else status = match.status;
  return {
    status,
    observationEntryId: match.observationEntryId,
    observationRecordIndex: match.observationRecordIndex,
    observation: observationDetails(match.observation, match.status),
    sourceEntryIds: match.sourceEntryIds,
    sourceEntries: match.sourceEntries.map((entry) =>
      sourceEntryDetails(entry, includeSourceContent),
    ),
    missingSourceEntryIds: match.missingSourceEntryIds,
    nonSourceEntryIds: match.nonSourceEntryIds,
    sourceCharacterCount: renderRecallSourceEntries(match.sourceEntries).length,
  };
}

function textResult(text: string, details: RecallObservationToolDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function emptyDetails(
  status: RecallObservationToolStatus,
  memoryId: string,
  message: string,
): RecallObservationToolDetails {
  return {
    status,
    memoryId,
    observationId: memoryId,
    collision: false,
    partial: false,
    reflections: [],
    directObservationMatches: [],
    observations: [],
    matches: [],
    sourceEntries: [],
    unavailableSupportingObservations: [],
    missingSourceEntryIds: [],
    nonSourceEntryIds: [],
    message,
  };
}

function aggregateStatus(
  details: Omit<RecallObservationToolDetails, "status">,
): RecallObservationToolStatus {
  const observationOnly =
    details.reflections.length === 0 && details.unavailableSupportingObservations.length === 0;
  if (details.partial) return "partial";
  if (
    observationOnly &&
    details.observations.some((match) => match.status === "source_unavailable")
  )
    return "source_unavailable";
  if (
    observationOnly &&
    details.observations.length > 0 &&
    details.sourceEntries.length === 0 &&
    details.matches.every((match) => (match.sourceEntries ?? []).length === 0)
  )
    return "no_source";
  return "ok";
}

function friendlyNoSourceMessage(memoryId: string): string {
  return `Observation ${memoryId} has no source entries associated with it.`;
}

function friendlySourceUnavailableMessage(match: RecallObservationMatchDetails): string {
  const missing =
    match.missingSourceEntryIds && match.missingSourceEntryIds.length > 0
      ? ` missing: ${match.missingSourceEntryIds.join(", ")}`
      : "";
  const nonSource =
    match.nonSourceEntryIds && match.nonSourceEntryIds.length > 0
      ? ` non-source: ${match.nonSourceEntryIds.join(", ")}`
      : "";
  return `Observation ${match.observation.id} has source entries associated, but some are unavailable on the current branch or are not source-renderable.${missing}${nonSource}`;
}

function reflectionLineText(reflection: ReflectionDetails): string {
  return `[${reflection.id}] ${reflection.content}`;
}

function observationLineText(observation: ObservationDetails): string {
  const status = observation.status === "dropped" ? " [dropped]" : "";
  return `[${observation.id}]${status} ${observation.timestamp} [${observation.relevance}] ${observation.content}`;
}

function directObservationMatches(
  result: Extract<RecallResult, { status: "found" }>,
): RecalledObservation[] {
  return result.observations.filter((match) => match.observation.id === result.memoryId);
}

function renderObservationOnlyTextFromResult(
  result: Extract<RecallResult, { status: "found" }>,
): string {
  const sections: string[] = [];
  if (result.collision)
    sections.push(
      `Memory id ${result.memoryId} matched multiple observations; returning all matching source results from the current branch.`,
    );
  for (const match of directObservationMatches(result)) {
    if (match.status === "dropped")
      sections.push(
        `Observation ${match.observation.id} is dropped from active memory but remains recallable.`,
      );
    if (match.missingSourceEntryIds.length > 0 || match.nonSourceEntryIds.length > 0) {
      sections.push(friendlySourceUnavailableMessage(observationMatchDetails(match, false)));
      continue;
    }
    if (match.sourceEntries.length === 0) {
      sections.push(friendlyNoSourceMessage(match.observation.id));
      continue;
    }
    const sourceText = renderRecallSourceEntries(match.sourceEntries);
    sections.push(
      sourceText.trim()
        ? sourceText
        : `Observation ${match.observation.id} has source entries associated, but they rendered no text content.`,
    );
  }
  return sections.join("\n\n");
}

function unavailableSupportingLineText(
  item: RecallUnavailableSupportingObservationDetails,
): string {
  return `Supporting observation ${item.observationId} is unavailable on the current branch.`;
}

function renderMemoryText(result: Extract<RecallResult, { status: "found" }>): string {
  const sections: string[] = [];
  if (result.collision)
    sections.push(
      `Memory id ${result.memoryId} matched multiple observations/reflections; returning all available evidence from the current branch.`,
    );
  if (result.reflections.length > 0)
    sections.push(
      `Reflections:\n${result.reflections.map((match) => reflectionLineText(reflectionDetails(match.reflection, match.reflectionRecordIndex))).join("\n")}`,
    );
  if (result.observations.length > 0)
    sections.push(
      `Observations:\n${result.observations.map((match) => observationLineText(observationDetails(match.observation, match.status))).join("\n")}`,
    );
  if (result.missingSupportingObservationIds.length > 0)
    sections.push(
      `Unavailable supporting observations:\n${result.missingSupportingObservationIds.map((id) => unavailableSupportingLineText({ observationId: id })).join("\n")}`,
    );
  if (result.missingSourceEntryIds.length > 0 || result.nonSourceEntryIds.length > 0) {
    const parts: string[] = [];
    if (result.missingSourceEntryIds.length > 0)
      parts.push(`missing: ${result.missingSourceEntryIds.join(", ")}`);
    if (result.nonSourceEntryIds.length > 0)
      parts.push(`non-source: ${result.nonSourceEntryIds.join(", ")}`);
    sections.push(`Unavailable source entries: ${parts.join("; ")}`);
  }
  const sourceText = renderRecallSourceEntries(result.sourceEntries);
  if (sourceText.trim()) sections.push(`Sources:\n${sourceText}`);
  if (sections.length === 0)
    sections.push(`Memory ${result.memoryId} was found, but no source evidence rendered.`);
  return sections.join("\n\n");
}

function resultDetails(
  result: Extract<RecallResult, { status: "found" }>,
  includeSourceContent = true,
): RecallObservationToolDetails {
  const reflections = result.reflections.map((match) =>
    reflectionDetails(match.reflection, match.reflectionRecordIndex),
  );
  const observations = result.observations.map((match) =>
    observationMatchDetails(match, includeSourceContent),
  );
  const directMatches = directObservationMatches(result).map((match) =>
    observationMatchDetails(match, includeSourceContent),
  );
  const sourceEntries = result.sourceEntries.map((entry) =>
    sourceEntryDetails(entry, includeSourceContent),
  );
  const detailWithoutStatus = {
    memoryId: result.memoryId,
    observationId: result.memoryId,
    collision: result.collision,
    partial: result.partial,
    reflections,
    directObservationMatches: directMatches,
    observations,
    matches: directMatches,
    sourceEntries,
    unavailableSupportingObservations: result.missingSupportingObservationIds.map(
      (observationId) => ({ observationId }),
    ),
    missingSourceEntryIds: result.missingSourceEntryIds,
    nonSourceEntryIds: result.nonSourceEntryIds,
    sourceCharacterCount: renderRecallSourceEntries(result.sourceEntries).length,
  };
  return { status: aggregateStatus(detailWithoutStatus), ...detailWithoutStatus };
}

function renderFoundResult(
  result: Extract<RecallResult, { status: "found" }>,
): ReturnType<typeof textResult> {
  const details = resultDetails(result);
  const text =
    result.kind === "observation"
      ? renderObservationOnlyTextFromResult(result)
      : renderMemoryText(result);
  return textResult(text, details);
}

type RequestedRecallIds = { ids: string[]; error?: string };

/**
 * Validate and normalize the `id`/`ids` tool parameters into one id list.
 *
 * @param {{ id?: string; ids?: string[] }} params Validated tool parameters.
 * @returns {RequestedRecallIds} Id list, or an error message when the input is ambiguous.
 */
function normalizeRequestedIds(params: { id?: string; ids?: string[] }): RequestedRecallIds {
  if (params.id !== undefined && params.ids !== undefined) {
    return { ids: [], error: "Pass either `id` or `ids`, not both." };
  }
  if (params.id !== undefined) return { ids: [params.id] };
  if (params.ids !== undefined && params.ids.length > 0) return { ids: [...params.ids] };
  return { ids: [], error: "Provide `id` (single string) or `ids` (array of strings)." };
}

function notFoundMessage(memoryId: string): string {
  return `No observation or reflection with id ${memoryId} was found on the current branch.`;
}

/**
 * Render the evidence text for one found id inside a batch recall.
 *
 * @param {Extract<RecallResult, { status: "found" }>} result Found recall result for one id.
 * @returns {string} Evidence text section.
 */
function batchSectionText(result: Extract<RecallResult, { status: "found" }>): string {
  return result.kind === "observation"
    ? renderObservationOnlyTextFromResult(result)
    : renderMemoryText(result);
}

function renderBatchResult(
  recalled: Array<{ memoryId: string; result: RecallResult }>,
): ReturnType<typeof textResult> {
  const sections: string[] = [];
  const batchDetails: RecallObservationToolDetails[] = [];
  for (const { memoryId, result } of recalled) {
    if (result.status === "not_found") {
      sections.push(notFoundMessage(memoryId));
      batchDetails.push(emptyDetails("not_found", memoryId, notFoundMessage(memoryId)));
      continue;
    }
    sections.push(batchSectionText(result));
    batchDetails.push(resultDetails(result));
  }
  const anyFound = batchDetails.some((entry) => entry.status !== "not_found");
  const details = emptyDetails(
    anyFound ? "ok" : "not_found",
    recalled[0]?.memoryId ?? "",
    `Recalled ${recalled.length} ids.`,
  );
  details.batchResults = batchDetails;
  return textResult(sections.join("\n\n---\n\n"), details);
}

const RecallObservationParamsSchema = Type.Object({
  id: Type.Optional(Type.String({ pattern: "^[a-f0-9]{12}$", description: MEMORY_ID_DESCRIPTION })),
  ids: Type.Optional(
    Type.Array(Type.String({ pattern: "^[a-f0-9]{12}$", description: MEMORY_ID_DESCRIPTION }), {
      minItems: 1,
      maxItems: MAX_RECALL_IDS,
      description: `Batch variant of id: recall several memories in one call (max ${MAX_RECALL_IDS}).`,
    }),
  ),
});

export const recallObservationTool = defineTool<
  typeof RecallObservationParamsSchema,
  RecallObservationToolDetails
>({
  name: RECALL_OBSERVATION_TOOL_NAME,
  label: "Recall memory evidence",
  description:
    "Recover exact evidence and source context behind one compacted observational-memory observation or reflection id — or a list of ids via `ids` — on the current branch. " +
    "Use when compressed memory is important and original source context is needed before acting.",
  promptSnippet:
    "Use recall(<id>) to recover exact source context behind compacted memory observations/reflections when precision matters.",
  promptGuidelines: [
    "Use recall before making an important decision that depends on a compacted observation or reflection whose details are unclear.",
    "Use recall when you need exact wording, rationale, file paths, commands, errors, commits, user constraints, or provenance behind a remembered claim.",
    "Use recall when a broad reflection is relevant but you need its supporting observations or raw sources to continue safely.",
    "Use recall when the user asks why you believe something, what supports a memory, or what was decided earlier.",
    "Do not use recall as semantic search or transcript browsing; you must already have a specific 12-character memory id.",
    "Do not recall every id preemptively. Recall only when exact source context will materially improve the next action.",
  ],
  parameters: RecallObservationParamsSchema,
  renderShell: "self",
  renderCall(args, theme, context) {
    return renderRecallCall(args, theme, context);
  },
  renderResult(result, options, theme, context) {
    return renderRecallResult(result, options, theme, context);
  },
  execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const requested = normalizeRequestedIds(params);
    if (requested.error !== undefined) {
      const message = requested.error;
      return Promise.resolve(
        textResult(message, emptyDetails("invalid_id", requested.ids[0] ?? "", message)),
      );
    }
    const malformed = requested.ids.filter((id) => !MEMORY_ID_PATTERN.test(id));
    if (malformed.length > 0) {
      const message = `Memory ids must be 12 lowercase hex characters. Received: ${malformed.join(", ")}`;
      return Promise.resolve(
        textResult(message, emptyDetails("invalid_id", malformed[0] ?? "", message)),
      );
    }
    const branchEntries = ctx.sessionManager.getBranch() as Entry[];
    const recalled = requested.ids.map((memoryId) => ({
      memoryId,
      result: recallMemorySources(branchEntries, memoryId),
    }));
    if (recalled.length === 1) {
      const only = recalled[0];
      if (only === undefined) {
        const message = "No memory id was provided.";
        return Promise.resolve(textResult(message, emptyDetails("invalid_id", "", message)));
      }
      if (only.result.status === "not_found") {
        const message = notFoundMessage(only.memoryId);
        return Promise.resolve(
          textResult(message, emptyDetails("not_found", only.memoryId, message)),
        );
      }
      return Promise.resolve(renderFoundResult(only.result));
    }
    return Promise.resolve(renderBatchResult(recalled));
  },
});

export function registerRecallTool(pi: ExtensionAPI): void {
  pi.registerTool(recallObservationTool);
}
