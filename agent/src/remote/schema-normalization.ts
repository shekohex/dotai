import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { JsonValueSchema } from "./json-schema.js";
import { RemoteModelSchema, type RemoteSessionEntry } from "./schemas-core.js";

type RemoteModelTransport = Static<typeof RemoteModelSchema>;

const BranchSummaryTransportSchema = Type.Object({
  type: Type.Literal("branch_summary"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  fromId: Type.String(),
  summary: Type.String(),
  details: Type.Optional(JsonValueSchema),
  fromHook: Type.Optional(Type.Boolean()),
});

type BranchSummaryTransport = Static<typeof BranchSummaryTransportSchema>;

export function toJsonValueOrUndefined(value: unknown): Static<typeof JsonValueSchema> | undefined {
  if (value === undefined || !Value.Check(JsonValueSchema, value)) {
    return undefined;
  }
  return Value.Parse(JsonValueSchema, value);
}

export function sanitizeRemoteModel(model: Model<Api>): RemoteModelTransport {
  const compat = toJsonValueOrUndefined(model.compat);
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
    ...(compat === undefined ? {} : { compat }),
  };
}

function includeJsonDetails(value: unknown): { details?: Static<typeof JsonValueSchema> } {
  const details = toJsonValueOrUndefined(value);
  if (details === undefined) {
    return {};
  }
  return { details };
}

function includeJsonData(value: unknown): { data?: Static<typeof JsonValueSchema> } {
  const data = toJsonValueOrUndefined(value);
  if (data === undefined) {
    return {};
  }
  return { data };
}

export function sanitizeSessionEntry(entry: SessionEntry): RemoteSessionEntry {
  if (entry.type === "compaction") {
    return {
      type: entry.type,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      summary: entry.summary,
      firstKeptEntryId: entry.firstKeptEntryId,
      tokensBefore: entry.tokensBefore,
      ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
      ...includeJsonDetails(entry.details),
    };
  }

  if (entry.type === "branch_summary") {
    return {
      type: entry.type,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      fromId: entry.fromId,
      summary: entry.summary,
      ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
      ...includeJsonDetails(entry.details),
    };
  }

  if (entry.type === "custom") {
    return {
      type: entry.type,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      customType: entry.customType,
      ...includeJsonData(entry.data),
    };
  }

  if (entry.type === "custom_message") {
    return {
      type: entry.type,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      customType: entry.customType,
      content: structuredClone(entry.content),
      display: entry.display,
      ...includeJsonDetails(entry.details),
    };
  }

  return structuredClone(entry);
}

export function sanitizeBranchSummaryEntry(
  entry: Extract<SessionEntry, { type: "branch_summary" }>,
): BranchSummaryTransport {
  const details = toJsonValueOrUndefined(entry.details);
  return {
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    fromId: entry.fromId,
    summary: entry.summary,
    ...(details === undefined ? {} : { details }),
    ...(entry.fromHook === undefined ? {} : { fromHook: entry.fromHook }),
  };
}

export function sanitizeCompactDetails(
  details: unknown,
): Static<typeof JsonValueSchema> | undefined {
  return toJsonValueOrUndefined(details);
}
