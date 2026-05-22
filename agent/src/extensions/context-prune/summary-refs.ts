import type { CapturedBatch, SummaryMessageDetails } from "./types.js";
import { isRecord } from "./guards.js";

export interface SummaryToolCallRef {
  shortId: string;
  toolCallId: string;
}

const SHORT_ID_PREFIX = "t";

function isSummaryToolCallRef(value: unknown): value is SummaryToolCallRef {
  return (
    isRecord(value) && typeof value.shortId === "string" && typeof value.toolCallId === "string"
  );
}

export function buildShortToolCallRefs(
  toolCallIds: string[],
  startIndex: number,
): { refs: SummaryToolCallRef[]; nextIndex: number } {
  const refs = toolCallIds.map((toolCallId, offset) => ({
    shortId: `${SHORT_ID_PREFIX}${startIndex + offset}`,
    toolCallId,
  }));
  return { refs, nextIndex: startIndex + refs.length };
}

export function normalizeSummaryToolCallRefs(details: unknown): SummaryToolCallRef[] {
  if (!isRecord(details)) return [];

  const toolCallRefs = details.toolCallRefs;
  if (Array.isArray(toolCallRefs)) {
    return toolCallRefs
      .filter((ref) => isSummaryToolCallRef(ref))
      .map((ref) => ({ shortId: ref.shortId, toolCallId: ref.toolCallId }));
  }

  const toolCallIds = details.toolCallIds;
  if (Array.isArray(toolCallIds)) {
    return toolCallIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => ({ shortId: id, toolCallId: id }));
  }

  return [];
}

export function formatSummaryToolCallRefs(refs: SummaryToolCallRef[]): string {
  const refList = refs.map((ref) => `\`${ref.shortId}\``).join(", ");
  return (
    `\n\n---\n**Summarized tool refs**: ${refList}\n` +
    `Use \`context_tree_query\` with these refs to retrieve the original full outputs.`
  );
}

export function makeSummaryDetails(
  batch: CapturedBatch,
  refs: SummaryToolCallRef[],
): SummaryMessageDetails {
  return {
    toolCallRefs: refs,
    toolNames: batch.toolCalls.map((tc) => tc.toolName),
    turnIndex: batch.turnIndex,
    timestamp: batch.timestamp,
  };
}
