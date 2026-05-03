import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  ContextUsageSchema,
  RemoteExtensionMetadataSchema,
  RemoteModelSchema,
  RemoteModelSettingsSchema,
  RemoteResourceBundleSchema,
  RemoteSettingsSnapshotSchema,
  SessionStatsSchema,
} from "../schemas.js";
import { sanitizeRemoteModel } from "../schema-normalization.js";
import { asRecord } from "../../utils/unknown-data.js";
import type { SessionRecord } from "./types.js";

export const REMOTE_AUTHORITATIVE_SESSION_METADATA_ENTRY = "remote-authoritative-session-metadata";

const AuthoritativeSessionMetadataSchema = Type.Object({
  model: Type.String(),
  thinkingLevel: Type.String(),
  activeTools: Type.Array(Type.String()),
  extensions: Type.Array(RemoteExtensionMetadataSchema),
  resources: Type.Optional(RemoteResourceBundleSchema),
  settings: Type.Optional(RemoteSettingsSnapshotSchema),
  availableModels: Type.Array(RemoteModelSchema),
  modelSettings: RemoteModelSettingsSchema,
  sessionStats: SessionStatsSchema,
  contextUsage: Type.Optional(ContextUsageSchema),
  usageCost: Type.Number(),
  autoCompactionEnabled: Type.Boolean(),
  steeringMode: Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]),
  followUpMode: Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]),
  updatedAt: Type.Number(),
});

export type AuthoritativeSessionMetadata = Static<typeof AuthoritativeSessionMetadataSchema>;

type RemoteDurableSessionManagerWriter = SessionManager & {
  appendCustomEntry: (customType: string, data: unknown) => void;
  getEntries: () => Array<{ type: string; customType?: string; data?: unknown }>;
};

export function persistAuthoritativeSessionMetadata(
  record: SessionRecord,
  updatedAt: number,
): void {
  const sessionManager = readDurableSessionManagerWriter(record.runtime.session?.sessionManager);
  if (sessionManager === undefined) {
    return;
  }

  const next = buildAuthoritativeSessionMetadata(record, updatedAt);
  const previous =
    record.authoritativeMetadataCache ??
    readAuthoritativeSessionMetadata(sessionManager.getEntries());
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(next)) {
    record.authoritativeMetadataCache = previous;
    return;
  }

  try {
    sessionManager.appendCustomEntry(REMOTE_AUTHORITATIVE_SESSION_METADATA_ENTRY, next);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }
  record.authoritativeMetadataCache = next;
}

export function readAuthoritativeSessionMetadata(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): AuthoritativeSessionMetadata | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "custom" &&
      entry.customType === REMOTE_AUTHORITATIVE_SESSION_METADATA_ENTRY &&
      Value.Check(AuthoritativeSessionMetadataSchema, entry.data)
    ) {
      return Value.Parse(AuthoritativeSessionMetadataSchema, entry.data);
    }
  }

  return undefined;
}

function buildAuthoritativeSessionMetadata(
  record: SessionRecord,
  updatedAt: number,
): AuthoritativeSessionMetadata {
  return {
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    activeTools: [...record.activeTools],
    extensions: record.extensions.map((extension) => ({ ...extension })),
    resources: structuredClone(record.resources),
    settings: { ...record.settings },
    availableModels: record.availableModels.map((model) => sanitizeRemoteModel({ ...model })),
    modelSettings: {
      defaultProvider: record.modelSettings.defaultProvider,
      defaultModel: record.modelSettings.defaultModel,
      defaultThinkingLevel: record.modelSettings.defaultThinkingLevel,
      enabledModels: record.modelSettings.enabledModels
        ? [...record.modelSettings.enabledModels]
        : null,
    },
    sessionStats: {
      ...record.sessionStats,
      tokens: { ...record.sessionStats.tokens },
      ...(record.sessionStats.contextUsage
        ? { contextUsage: { ...record.sessionStats.contextUsage } }
        : {}),
    },
    ...(record.contextUsage ? { contextUsage: { ...record.contextUsage } } : {}),
    usageCost: record.usageCost,
    autoCompactionEnabled: record.autoCompactionEnabled,
    steeringMode: record.steeringMode,
    followUpMode: record.followUpMode,
    updatedAt,
  };
}

function readDurableSessionManagerWriter(
  sessionManager: SessionManager | undefined,
): RemoteDurableSessionManagerWriter | undefined {
  if (!isRemoteDurableSessionManagerWriter(sessionManager)) {
    return undefined;
  }

  return sessionManager;
}

function isRemoteDurableSessionManagerWriter(
  sessionManager: SessionManager | undefined,
): sessionManager is RemoteDurableSessionManagerWriter {
  const candidate = asRecord(sessionManager);
  return (
    candidate !== undefined &&
    typeof candidate.appendCustomEntry === "function" &&
    typeof candidate.getEntries === "function"
  );
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
