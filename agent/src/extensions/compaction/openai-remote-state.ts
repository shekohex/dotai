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
  ResponsesTextConfig,
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
): Record<string, unknown> | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  const nextPayload: Record<string, unknown> = { ...record, input: explicitHistory };
  delete nextPayload.messages;
  delete nextPayload.previous_response_id;
  return nextPayload;
}

export function extractResponsesRequestShape(payload: unknown):
  | {
      reasoning?: ResponsesReasoningConfig;
      text?: ResponsesTextConfig;
    }
  | undefined {
  const record = asRecord(payload);
  if (record === undefined) return undefined;
  if (record.input === undefined && record.messages === undefined && record.model === undefined) {
    return undefined;
  }
  const reasoning = Value.Check(RequestReasoningSchema, record.reasoning)
    ? Value.Parse(RequestReasoningSchema, record.reasoning)
    : undefined;
  const text = asRecord(record.text);
  return {
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
