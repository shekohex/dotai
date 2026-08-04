import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertToLlm, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { asRecord } from "../../utils/unknown-data.js";
import { normalizeResponseItemsForPrompt } from "./openai-remote-messages.js";
import type { RemoteCompactionSessionState, ResponseItem } from "./openai-remote-types.js";

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

type FreshAuthoritativePreamble = {
  instructions?: string;
  leadingInput: ResponseItem[];
  trailingInput: ResponseItem[];
};

export type RemoteReplayResult =
  | { ok: true; rewrittenPayload: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | "compaction-boundary-not-found"
        | "first-kept-entry-not-found"
        | "unsupported-instructions"
        | "invalid-compacted-window"
        | "expected-pi-replay-mismatch";
      mismatches?: string[];
    };

function cloneStructuredValue(value: unknown): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cloneStructuredValue(item));
  const record = asRecord(value);
  if (record === undefined) throw new Error(`Unsupported structured value: ${typeof value}`);
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [key, cloneStructuredValue(nested)]),
  );
}

function cloneResponseItems(items: readonly unknown[]): ResponseItem[] | undefined {
  try {
    return items.map((item) => {
      const clone = asRecord(cloneStructuredValue(item));
      if (clone === undefined) throw new Error("Responses input item must be an object.");
      return clone;
    });
  } catch {
    return undefined;
  }
}

function areEquivalentValues(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => areEquivalentValues(value, right[index]));
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord !== undefined || rightRecord !== undefined) {
    if (leftRecord === undefined || rightRecord === undefined) return false;
    const leftKeys = Object.keys(leftRecord).toSorted();
    const rightKeys = Object.keys(rightRecord).toSorted();
    return (
      areEquivalentValues(leftKeys, rightKeys) &&
      leftKeys.every((key) => areEquivalentValues(leftRecord[key], rightRecord[key]))
    );
  }
  return false;
}

function isPreambleItem(item: unknown): boolean {
  const role = asRecord(item)?.role;
  return role === "developer" || role === "system";
}

function extractFreshAuthoritativePreamble(
  payload: Record<string, unknown>,
): FreshAuthoritativePreamble | undefined {
  if (payload.instructions !== undefined && typeof payload.instructions !== "string") {
    return undefined;
  }
  if (!Array.isArray(payload.input)) return undefined;
  let leadingBoundary = 0;
  while (leadingBoundary < payload.input.length && isPreambleItem(payload.input[leadingBoundary])) {
    leadingBoundary += 1;
  }
  let trailingBoundary = payload.input.length;
  while (
    trailingBoundary > leadingBoundary &&
    isPreambleItem(payload.input[trailingBoundary - 1])
  ) {
    trailingBoundary -= 1;
  }
  for (let index = leadingBoundary; index < trailingBoundary; index += 1) {
    if (isPreambleItem(payload.input[index])) return undefined;
  }
  const leadingInput = cloneResponseItems(payload.input.slice(0, leadingBoundary));
  const trailingInput = cloneResponseItems(payload.input.slice(trailingBoundary));
  if (leadingInput === undefined || trailingInput === undefined) return undefined;
  return {
    ...(typeof payload.instructions === "string" ? { instructions: payload.instructions } : {}),
    leadingInput,
    trailingInput,
  };
}

function toReplayMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: Date.parse(entry.timestamp),
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: Date.parse(entry.timestamp),
    };
  }
  return undefined;
}

function collectReplayMessages(entries: readonly SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => {
    const message = toReplayMessage(entry);
    return message === undefined ? [] : [message];
  });
}

function serializeMessages(model: Model<Api>, messages: AgentMessage[]): ResponseItem[] {
  return normalizeResponseItemsForPrompt(
    convertResponsesMessages(
      model,
      { messages: convertToLlm(messages) },
      CODEX_TOOL_CALL_PROVIDERS,
      { includeSystemPrompt: false },
    ),
    model,
  );
}

function compactionSummaryMessage(entry: CompactionEntry): AgentMessage {
  return {
    role: "compactionSummary",
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
    timestamp: Date.parse(entry.timestamp),
  };
}

function findEntryIndexBeforeBoundary(
  entries: readonly SessionEntry[],
  entryId: string,
  boundaryIndex: number,
): number | undefined {
  const index = entries.findIndex(
    (entry, candidateIndex) => candidateIndex < boundaryIndex && entry.id === entryId,
  );
  return index < 0 ? undefined : index;
}

function conversationInput(
  payloadInput: readonly unknown[],
  preamble: FreshAuthoritativePreamble,
): ResponseItem[] | undefined {
  const endIndex = payloadInput.length - preamble.trailingInput.length;
  if (endIndex < preamble.leadingInput.length) return undefined;
  return cloneResponseItems(payloadInput.slice(preamble.leadingInput.length, endIndex));
}

function stripLeadingCompactionSummary(
  input: ResponseItem[],
  compactionSummaryInput: ResponseItem[],
): ResponseItem[] {
  return compactionSummaryInput.length > 0 &&
    areEquivalentValues(input.slice(0, compactionSummaryInput.length), compactionSummaryInput)
    ? input.slice(compactionSummaryInput.length)
    : input;
}

function paritySignatures(items: readonly unknown[]): string[] {
  return items.map((value) => {
    const item = asRecord(value);
    if (item === undefined) return typeof value;
    const type = typeof item.type === "string" ? item.type : "message";
    if (type === "message") return `message:${String(item.role)}:${String(item.phase)}`;
    if (type === "function_call") return `function_call:${String(item.name)}`;
    return type;
  });
}

function responseItemIdentity(item: ResponseItem): string {
  const type = typeof item.type === "string" ? item.type : "message";
  if (typeof item.call_id === "string") return `${type}:call:${item.call_id}`;
  if (type === "message") {
    const content = Array.isArray(item.content)
      ? item.content.map((value: unknown): unknown => {
          const part = asRecord(value);
          if (part === undefined) return value;
          const normalized = { ...part };
          delete normalized.annotations;
          return normalized;
        })
      : item.content;
    return `${type}:${String(item.role)}:${String(item.phase)}:${JSON.stringify(content)}`;
  }
  if (type === "reasoning" && typeof item.encrypted_content === "string") {
    return `${type}:encrypted:${item.encrypted_content}`;
  }
  if (typeof item.id === "string") return `${type}:id:${item.id}`;
  return `${type}:${JSON.stringify(item)}`;
}

function alignRemoteTailToFreshInput(
  remoteTail: ResponseItem[],
  freshConversation: ResponseItem[],
): number[] | undefined {
  if (remoteTail.length === 0) return [];
  const matches = Array.from({ length: remoteTail.length }, () => -1);
  let freshCursor = freshConversation.length - 1;
  for (let remoteIndex = remoteTail.length - 1; remoteIndex >= 0; remoteIndex -= 1) {
    const identity = responseItemIdentity(remoteTail[remoteIndex]);
    let matchedIndex = -1;
    for (let index = freshCursor; index >= 0; index -= 1) {
      if (responseItemIdentity(freshConversation[index]) !== identity) continue;
      matchedIndex = index;
      break;
    }
    if (matchedIndex < 0) return undefined;
    matches[remoteIndex] = matchedIndex;
    freshCursor = matchedIndex - 1;
  }
  return matches;
}

export function rewriteRemoteCompactionPayload(params: {
  model: Model<Api>;
  payload: unknown;
  branchEntries: readonly SessionEntry[];
  state: RemoteCompactionSessionState;
}): RemoteReplayResult {
  const payload = asRecord(params.payload);
  if (payload === undefined || !Array.isArray(payload.input)) {
    return { ok: false, reason: "expected-pi-replay-mismatch" };
  }
  const boundaryIndex = params.branchEntries.findIndex(
    (entry) => entry.id === params.state.compactionEntryId,
  );
  if (boundaryIndex < 0) return { ok: false, reason: "compaction-boundary-not-found" };
  const compactionEntry = params.branchEntries[boundaryIndex];
  if (compactionEntry?.type !== "compaction") {
    return { ok: false, reason: "compaction-boundary-not-found" };
  }
  const firstKeptEntryIndex = findEntryIndexBeforeBoundary(
    params.branchEntries,
    compactionEntry.firstKeptEntryId,
    boundaryIndex,
  );
  if (firstKeptEntryIndex === undefined) {
    return { ok: false, reason: "first-kept-entry-not-found" };
  }
  const preamble = extractFreshAuthoritativePreamble(payload);
  if (preamble === undefined) return { ok: false, reason: "unsupported-instructions" };
  const compactedWindow = cloneResponseItems(params.state.replacementHistory);
  if (compactedWindow === undefined || compactedWindow.length === 0) {
    return { ok: false, reason: "invalid-compacted-window" };
  }
  const summaryInput = serializeMessages(params.model, [compactionSummaryMessage(compactionEntry)]);
  const freshConversation = conversationInput(payload.input, preamble);
  if (freshConversation === undefined) {
    return { ok: false, reason: "expected-pi-replay-mismatch" };
  }
  const hasNewerCompaction = params.branchEntries
    .slice(boundaryIndex + 1)
    .some((entry) => entry.type === "compaction");
  if (hasNewerCompaction) {
    const replayConversation = stripLeadingCompactionSummary(freshConversation, summaryInput);
    return {
      ok: true,
      rewrittenPayload: {
        ...payload,
        ...(preamble.instructions === undefined ? {} : { instructions: preamble.instructions }),
        input: [
          ...preamble.leadingInput,
          ...compactedWindow,
          ...replayConversation,
          ...preamble.trailingInput,
        ],
      },
    };
  }

  const preCompactionEntries = params.branchEntries.slice(firstKeptEntryIndex, boundaryIndex);
  const postCompactionEntries = params.branchEntries.slice(boundaryIndex + 1);
  const preCompactionVariants = [
    serializeMessages(params.model, collectReplayMessages(preCompactionEntries)),
    [],
  ];
  const postCompactionInput = serializeMessages(
    params.model,
    collectReplayMessages(postCompactionEntries),
  );
  for (const preCompactionInput of preCompactionVariants) {
    const expectedPrefix = [...summaryInput, ...preCompactionInput, ...postCompactionInput];
    if (!areEquivalentValues(freshConversation.slice(0, expectedPrefix.length), expectedPrefix)) {
      continue;
    }
    const extraTail = freshConversation.slice(expectedPrefix.length);
    return {
      ok: true,
      rewrittenPayload: {
        ...payload,
        ...(preamble.instructions === undefined ? {} : { instructions: preamble.instructions }),
        input: [
          ...preamble.leadingInput,
          ...compactedWindow,
          ...postCompactionInput,
          ...extraTail,
          ...preamble.trailingInput,
        ],
      },
    };
  }

  const matches = alignRemoteTailToFreshInput(postCompactionInput, freshConversation);
  const firstMatch = matches?.[0];
  if (firstMatch !== undefined) {
    return {
      ok: true,
      rewrittenPayload: {
        ...payload,
        ...(preamble.instructions === undefined ? {} : { instructions: preamble.instructions }),
        input: [
          ...preamble.leadingInput,
          ...compactedWindow,
          ...freshConversation.slice(firstMatch),
          ...preamble.trailingInput,
        ],
      },
    };
  }

  const actual = paritySignatures(freshConversation);
  const expected = paritySignatures([
    ...summaryInput,
    ...serializeMessages(params.model, collectReplayMessages(preCompactionEntries)),
    ...postCompactionInput,
  ]);
  return {
    ok: false,
    reason: "expected-pi-replay-mismatch",
    mismatches: expected.flatMap((value, index) =>
      actual[index] === value
        ? []
        : [`index ${index}: expected ${value}, got ${actual[index] ?? "<missing>"}`],
    ),
  };
}
