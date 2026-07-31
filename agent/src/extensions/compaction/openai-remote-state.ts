import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { asRecord } from "../../utils/unknown-data.js";
import { messageToResponseItems } from "./openai-remote-messages.js";
import { remoteCompactionModelKey } from "./openai-remote-protocol.js";
import type {
  RemoteCompactionDetails,
  RemoteCompactionSessionState,
  ResponseItem,
  ResponsesReasoningConfig,
  ResponsesRequestShape,
} from "./openai-remote-types.js";

const ResponseItemSchema = Type.Object({ type: Type.String() }, { additionalProperties: true });

const UsageCostSchema = Type.Object(
  {
    input: Type.Optional(Type.Number()),
    output: Type.Optional(Type.Number()),
    cacheRead: Type.Optional(Type.Number()),
    cacheWrite: Type.Optional(Type.Number()),
    total: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const UsageSchema = Type.Object(
  {
    input: Type.Optional(Type.Number()),
    output: Type.Optional(Type.Number()),
    cacheRead: Type.Optional(Type.Number()),
    cacheWrite: Type.Optional(Type.Number()),
    totalTokens: Type.Optional(Type.Number()),
    cost: Type.Optional(UsageCostSchema),
  },
  { additionalProperties: true },
);

function parsePersistedUsage(value: unknown): Usage | undefined {
  if (!Value.Check(UsageSchema, value)) return undefined;
  const usage = Value.Parse(UsageSchema, value);
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const cost = usage.cost;
  const costInput = cost?.input ?? 0;
  const costOutput = cost?.output ?? 0;
  const costCacheRead = cost?.cacheRead ?? 0;
  const costCacheWrite = cost?.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: cost?.total ?? costInput + costOutput + costCacheRead + costCacheWrite,
    },
  };
}

const RemoteCompactionDetailsSchema = Type.Object(
  {
    version: Type.Union([Type.Literal(1), Type.Literal(2)]),
    provider: Type.Union([
      Type.Literal("openai-responses-compact"),
      Type.Literal("openai-responses-compaction"),
    ]),
    implementation: Type.Optional(
      Type.Union([Type.Literal("responses_compact_v1"), Type.Literal("responses_compaction_v2")]),
    ),
    modelKey: Type.Optional(Type.String()),
    replacementHistory: Type.Array(Type.Unknown()),
    usage: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const RemoteCompactionEnvelopeSchema = Type.Object(
  { remoteCompaction: RemoteCompactionDetailsSchema },
  { additionalProperties: true },
);

const RequestReasoningSchema = Type.Object(
  {
    effort: Type.Optional(
      Type.Union([
        Type.Literal("none"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
    summary: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("concise"),
        Type.Literal("detailed"),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: true },
);

const RequestInputSchema = Type.Array(Type.Unknown());
const RequestContentSchema = Type.Array(Type.Unknown());
const RequestToolsSchema = Type.Array(Type.Record(Type.String(), Type.Unknown()));

function normalizeRemoteCompactionDetails(details: {
  version: 1 | 2;
  provider: "openai-responses-compact" | "openai-responses-compaction";
  implementation?: "responses_compact_v1" | "responses_compaction_v2";
  modelKey?: string;
  replacementHistory: unknown[];
  usage?: unknown;
}): RemoteCompactionDetails | undefined {
  const isLegacy = details.provider === "openai-responses-compact" && details.version === 1;
  const isCurrent = details.provider === "openai-responses-compaction" && details.version === 2;
  const replacementHistory = details.replacementHistory
    .filter((item) => Value.Check(ResponseItemSchema, item))
    .map((item) => Value.Parse(ResponseItemSchema, item));
  if ((!isLegacy && !isCurrent) || replacementHistory.length === 0) return undefined;
  const usage = parsePersistedUsage(details.usage);
  return {
    version: isCurrent ? 2 : 1,
    provider: isCurrent ? "openai-responses-compaction" : "openai-responses-compact",
    implementation: isCurrent ? "responses_compaction_v2" : "responses_compact_v1",
    modelKey: details.modelKey ?? "",
    replacementHistory,
    ...(usage === undefined ? {} : { usage }),
  };
}

export function buildRemoteCompactionDetails(
  model: Model<Api>,
  replacementHistory: ResponseItem[],
  usage?: Usage,
): RemoteCompactionDetails {
  return {
    version: 2,
    provider: "openai-responses-compaction",
    implementation: "responses_compaction_v2",
    modelKey: remoteCompactionModelKey(model),
    replacementHistory,
    ...(usage === undefined ? {} : { usage }),
  };
}

export function extractRemoteCompactionDetails(
  details: unknown,
): RemoteCompactionDetails | undefined {
  if (Value.Check(RemoteCompactionEnvelopeSchema, details)) {
    const parsed = Value.Parse(RemoteCompactionEnvelopeSchema, details);
    return normalizeRemoteCompactionDetails(parsed.remoteCompaction);
  }
  if (!Value.Check(RemoteCompactionDetailsSchema, details)) return undefined;
  return normalizeRemoteCompactionDetails(Value.Parse(RemoteCompactionDetailsSchema, details));
}

function assistantMessageMatchesModelKey(message: AgentMessage, targetModelKey: string): boolean {
  if (message.role !== "assistant") return false;
  const [provider, api, modelId] = targetModelKey.split(":", 3);
  if (!provider || !api || !modelId) return false;
  return provider === message.provider && modelId === message.model;
}

export function reconstructRemoteCompactionState(
  branchEntries: readonly SessionEntry[],
): RemoteCompactionSessionState | undefined {
  let latestCompactionIndex = -1;
  let latestCompactionEntryId = "";
  let latestDetails: RemoteCompactionDetails | undefined;

  branchEntries.forEach((entry, index) => {
    if (entry.type !== "compaction") return;
    latestCompactionIndex = index;
    latestCompactionEntryId = entry.id;
    latestDetails = extractRemoteCompactionDetails(entry.details);
  });
  if (latestDetails === undefined || latestCompactionIndex < 0) return undefined;

  const trailingMessages: ResponseItem[] = [];
  let pendingTurnItems: ResponseItem[] = [];
  for (const entry of branchEntries.slice(latestCompactionIndex + 1)) {
    if (entry.type === "custom_message") {
      const items = messageToResponseItems({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: Date.parse(entry.timestamp),
      });
      pendingTurnItems.push(...items);
      continue;
    }
    if (entry.type !== "message") continue;
    const items = messageToResponseItems(entry.message);
    if (items.length === 0) continue;
    if (entry.message.role === "assistant") {
      if (assistantMessageMatchesModelKey(entry.message, latestDetails.modelKey)) {
        trailingMessages.push(...pendingTurnItems, ...items);
      }
      pendingTurnItems = [];
      continue;
    }
    pendingTurnItems.push(...items);
  }

  return {
    compactionEntryId: latestCompactionEntryId,
    modelKey: latestDetails.modelKey,
    replacementHistory: latestDetails.replacementHistory,
    explicitHistory: [...latestDetails.replacementHistory, ...trailingMessages],
  };
}

export function messageMatchesModel(message: AgentMessage, model: Model<Api>): boolean {
  return (
    message.role === "assistant" &&
    message.provider === model.provider &&
    message.model === model.id
  );
}

export function applyRemoteHistoryPayload(
  payload: unknown,
  explicitHistory: ResponseItem[],
  replacementHistoryLength = 0,
): Record<string, unknown> | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  const nextPayload: Record<string, unknown> = {
    ...record,
    input: mergeRemoteHistoryWithFreshPayload(record, explicitHistory, replacementHistoryLength),
  };
  delete nextPayload.messages;
  delete nextPayload.previous_response_id;
  return nextPayload;
}

type ProviderInputItem = Record<string, unknown>;

function parseResponseInput(record: Record<string, unknown>): ProviderInputItem[] {
  if (!Value.Check(RequestInputSchema, record.input)) return [];
  return Value.Parse(RequestInputSchema, record.input).flatMap((value) => {
    const item = asRecord(value);
    return item === undefined ? [] : [structuredClone(item)];
  });
}

function isProviderPreambleItem(item: ProviderInputItem): boolean {
  return item.role === "developer" || item.role === "system";
}

function splitFreshProviderInput(input: ProviderInputItem[]): {
  leading: ProviderInputItem[];
  conversation: ProviderInputItem[];
  trailing: ProviderInputItem[];
} {
  let leadingEnd = 0;
  while (leadingEnd < input.length && isProviderPreambleItem(input[leadingEnd])) leadingEnd += 1;
  let trailingStart = input.length;
  while (trailingStart > leadingEnd && isProviderPreambleItem(input[trailingStart - 1])) {
    trailingStart -= 1;
  }
  return {
    leading: input.slice(0, leadingEnd),
    conversation: input.slice(leadingEnd, trailingStart),
    trailing: input.slice(trailingStart),
  };
}

function providerInputItemType(item: ProviderInputItem): string {
  if (typeof item.type === "string") return item.type;
  return typeof item.role === "string" ? "message" : "unknown";
}

function responseItemIdentity(item: ProviderInputItem): string {
  const type = providerInputItemType(item);
  if (typeof item.call_id === "string") return `${type}:call:${item.call_id}`;
  if (typeof item.id === "string") return `${type}:id:${item.id}`;
  if (type === "message") {
    return `${type}:${String(item.role)}:${JSON.stringify(item.content)}`;
  }
  if (type === "reasoning" && typeof item.encrypted_content === "string") {
    return `${type}:encrypted:${item.encrypted_content}`;
  }
  return `${type}:${JSON.stringify(item)}`;
}

function alignRemoteTailToFreshInput(
  remoteTail: ResponseItem[],
  freshConversation: ProviderInputItem[],
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

function mergeAlignedProviderTail(
  remoteTail: ResponseItem[],
  freshConversation: ProviderInputItem[],
  matches: number[],
): ProviderInputItem[] {
  if (remoteTail.length === 0) return [];
  const merged: ProviderInputItem[] = [];
  for (const [remoteIndex, remoteItem] of remoteTail.entries()) {
    merged.push(structuredClone(remoteItem));
    const freshIndex = matches[remoteIndex];
    const nextFreshIndex = matches[remoteIndex + 1] ?? freshConversation.length;
    merged.push(
      ...freshConversation
        .slice(freshIndex + 1, nextFreshIndex)
        .map((item) => structuredClone(item)),
    );
  }
  return merged;
}

function isClientToolSearchPair(call: ProviderInputItem, output: ProviderInputItem): boolean {
  return (
    call.type === "tool_search_call" &&
    output.type === "tool_search_output" &&
    call.execution === "client" &&
    output.execution === "client" &&
    typeof call.call_id === "string" &&
    call.call_id === output.call_id
  );
}

function mergeClientToolSearchFallback(
  explicitHistory: ResponseItem[],
  freshConversation: ProviderInputItem[],
): ProviderInputItem[] {
  const merged: ProviderInputItem[] = explicitHistory.map((item) => structuredClone(item));
  const existingCallIds = new Set(
    merged.flatMap((item) =>
      item.type === "tool_search_call" && typeof item.call_id === "string" ? [item.call_id] : [],
    ),
  );
  for (let index = 0; index < freshConversation.length - 1; index += 1) {
    const call = freshConversation[index];
    const output = freshConversation[index + 1];
    if (!isClientToolSearchPair(call, output) || existingCallIds.has(String(call.call_id))) {
      continue;
    }
    const anchor = freshConversation[index - 1];
    const anchorIdentity = anchor === undefined ? undefined : responseItemIdentity(anchor);
    let insertAt = merged.length;
    if (anchorIdentity !== undefined) {
      const anchorIndex = merged.findLastIndex(
        (item) => responseItemIdentity(item) === anchorIdentity,
      );
      if (anchorIndex >= 0) insertAt = anchorIndex + 1;
    }
    merged.splice(insertAt, 0, structuredClone(call), structuredClone(output));
    existingCallIds.add(String(call.call_id));
    index += 1;
  }
  return merged;
}

function mergeRemoteHistoryWithFreshPayload(
  record: Record<string, unknown>,
  explicitHistory: ResponseItem[],
  replacementHistoryLength: number,
): ProviderInputItem[] {
  const fresh = splitFreshProviderInput(parseResponseInput(record));
  const replacementEnd = Math.min(explicitHistory.length, Math.max(0, replacementHistoryLength));
  const replacementHistory = explicitHistory.slice(0, replacementEnd);
  const remoteTail = explicitHistory.slice(replacementEnd);
  const matches = alignRemoteTailToFreshInput(remoteTail, fresh.conversation);
  const replayHistory =
    matches === undefined
      ? mergeClientToolSearchFallback(explicitHistory, fresh.conversation)
      : [
          ...replacementHistory.map((item) => structuredClone(item)),
          ...mergeAlignedProviderTail(remoteTail, fresh.conversation, matches),
        ];
  return [
    ...fresh.leading.map((item) => structuredClone(item)),
    ...replayHistory,
    ...fresh.trailing.map((item) => structuredClone(item)),
  ];
}

function extractProviderInstructions(record: Record<string, unknown>): string | undefined {
  if (typeof record.instructions === "string") return record.instructions;
  if (!Value.Check(RequestInputSchema, record.input)) return undefined;
  for (const value of Value.Parse(RequestInputSchema, record.input)) {
    const item = asRecord(value);
    if (item?.role !== "developer" && item?.role !== "system") continue;
    if (typeof item.content === "string") return item.content;
    if (!Value.Check(RequestContentSchema, item.content)) continue;
    const text = Value.Parse(RequestContentSchema, item.content)
      .flatMap((part) => {
        const contentPart = asRecord(part);
        return contentPart?.type === "input_text" && typeof contentPart.text === "string"
          ? [contentPart.text]
          : [];
      })
      .join("\n");
    if (text.length > 0) return text;
  }
  return undefined;
}

function extractProviderTools(
  record: Record<string, unknown>,
): Record<string, unknown>[] | undefined {
  const tools: Record<string, unknown>[] = [];
  let foundTools = false;
  if (Value.Check(RequestToolsSchema, record.tools)) {
    foundTools = true;
    tools.push(
      ...Value.Parse(RequestToolsSchema, record.tools).map((tool) => structuredClone(tool)),
    );
  }
  if (!Value.Check(RequestInputSchema, record.input)) return foundTools ? tools : undefined;
  for (const value of Value.Parse(RequestInputSchema, record.input)) {
    const item = asRecord(value);
    if (item?.type !== "tool_search_output" || item.execution !== "client") continue;
    if (!Value.Check(RequestToolsSchema, item.tools)) continue;
    foundTools = true;
    tools.push(...Value.Parse(RequestToolsSchema, item.tools).map((tool) => structuredClone(tool)));
  }
  return foundTools ? tools : undefined;
}

export function extractResponsesRequestShape(payload: unknown): ResponsesRequestShape | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  if (record.input === undefined && record.messages === undefined && record.model === undefined) {
    return undefined;
  }
  const instructions = extractProviderInstructions(record);
  const tools = extractProviderTools(record);
  const reasoning = Value.Check(RequestReasoningSchema, record.reasoning)
    ? Value.Parse(RequestReasoningSchema, record.reasoning)
    : undefined;
  const text = asRecord(record.text);
  return {
    ...(instructions === undefined ? {} : { instructions }),
    ...(tools === undefined ? {} : { tools }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(text === undefined ? {} : { text: structuredClone(text) }),
  };
}

export function thinkingLevelToResponsesReasoning(
  thinkingLevel: ThinkingLevel | undefined,
): ResponsesReasoningConfig | undefined {
  if (thinkingLevel === "minimal") return { effort: "minimal", summary: "auto" };
  if (thinkingLevel === "low") return { effort: "low", summary: "auto" };
  if (thinkingLevel === "medium") return { effort: "medium", summary: "auto" };
  if (thinkingLevel === "high") return { effort: "high", summary: "auto" };
  if (thinkingLevel === "xhigh") return { effort: "xhigh", summary: "auto" };
  return undefined;
}

export function remoteCompactionSummaryText(model: Model<Api>): string {
  let host = "OpenAI";
  try {
    host = new URL(model.baseUrl).hostname;
  } catch {
    // Keep generic provider label for malformed custom base URLs.
  }
  return `OpenAI remote compaction applied for ${model.provider}/${model.id} via ${host}. Pi keeps this textual summary for portability, while compatible future turns use provider-native replacement history stored in compaction details.`;
}
