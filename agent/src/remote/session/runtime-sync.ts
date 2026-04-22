import type { AgentSessionRuntime, SessionStats } from "@mariozechner/pi-coding-agent";
import type { SessionSnapshot, SessionStatus } from "../schemas.js";
import { RemoteError } from "../errors.js";
import { appEventsStreamId, sessionEventsStreamId } from "../streams.js";
import { parseResourceLoaderExtensionMetadata, parseRuntimeExtensionMetadata } from "./helpers.js";
import { applyRuntimeResourcesSnapshot } from "./runtime-resources-sync.js";
import { buildSessionSnapshotParts } from "./runtime-sync-snapshot.js";
import { createEmptySessionStats, type SessionRecord } from "./types.js";

export function syncSessionRecordFromRuntime(input: {
  record: SessionRecord;
  now: () => number;
  options?: {
    now?: number;
    updateTimestamp?: boolean;
    syncResources?: boolean;
  };
  getRuntimeSession: (record: SessionRecord) => AgentSessionRuntime["session"] | undefined;
}): void {
  const session = input.getRuntimeSession(input.record);
  if (!session) {
    return;
  }

  const now = input.options?.now ?? input.now();
  const updateTimestamp = input.options?.updateTimestamp ?? true;
  const syncResources = input.options?.syncResources ?? false;
  applyRuntimeSnapshot(input.record, session, syncResources);
  if (updateTimestamp) {
    input.record.updatedAt = now;
  }

  if (input.record.activeRun) {
    if (updateTimestamp) {
      input.record.activeRun.updatedAt = now;
    }
    input.record.activeRun.queueDepth = input.record.queue.depth;
    input.record.activeRun.status = input.record.status;
    if (!session.isStreaming && input.record.queue.depth === 0) {
      input.record.activeRun = null;
    }
  }
}

function applyRuntimeSnapshot(
  record: SessionRecord,
  session: NonNullable<AgentSessionRuntime["session"]>,
  syncResources: boolean,
): void {
  record.cwd = session.sessionManager.getCwd();
  record.extensions = readRuntimeExtensionMetadata(record.runtime);
  if (syncResources) {
    applyRuntimeResourcesSnapshot(record, session);
  }
  applyRuntimeModelSnapshot(record, session);
  record.transcript = [...session.messages];
  record.streamingState = session.isStreaming ? "streaming" : "idle";
  record.pendingToolCalls = [...session.state.pendingToolCalls.values()];
  applyRuntimeErrorSnapshot(record, session.state.errorMessage ?? null);
  record.retry.status = session.isRetrying ? "running" : "idle";
  record.compaction.status = session.isCompacting ? "running" : "idle";
  record.queue.depth =
    session.pendingMessageCount +
    (session.isStreaming ? 1 : 0) +
    record.runtimeUndispatchedCommandCount;
  record.status = deriveRuntimeSessionStatus(session, record.errorMessage);
}

function applyRuntimeModelSnapshot(
  record: SessionRecord,
  session: NonNullable<AgentSessionRuntime["session"]>,
): void {
  const selectedModel = session.model;
  if (selectedModel) {
    record.model = `${selectedModel.provider}/${selectedModel.id}`;
  }
  record.thinkingLevel = session.thinkingLevel;
  record.activeTools = [...session.getActiveToolNames()];
  record.autoCompactionEnabled = session.autoCompactionEnabled;
  record.steeringMode = session.steeringMode === "one-at-a-time" ? "one-at-a-time" : "all";
  record.followUpMode = session.followUpMode === "one-at-a-time" ? "one-at-a-time" : "all";
  const sessionStats = readSessionStats(record.sessionId, session);
  record.sessionStats = sessionStats;
  record.contextUsage = sessionStats.contextUsage ? { ...sessionStats.contextUsage } : undefined;
  record.usageCost = sessionStats.cost;
  record.availableModels = session.modelRegistry
    .getAvailable()
    .map((availableModel) => ({ ...availableModel }));
  record.modelSettings = {
    defaultProvider: session.settingsManager.getDefaultProvider() ?? null,
    defaultModel: session.settingsManager.getDefaultModel() ?? null,
    defaultThinkingLevel: session.settingsManager.getDefaultThinkingLevel() ?? null,
    enabledModels: session.settingsManager.getEnabledModels() ?? null,
  };
}

function readSessionStats(
  sessionId: string,
  session: NonNullable<AgentSessionRuntime["session"]>,
): SessionRecord["sessionStats"] {
  if (typeof session.getSessionStats !== "function") {
    const fallback = createEmptySessionStats(sessionId);
    if (typeof session.getContextUsage === "function") {
      const contextUsage = session.getContextUsage();
      if (contextUsage) {
        fallback.contextUsage = { ...contextUsage };
      }
    }
    return fallback;
  }

  return cloneSessionStats(session.getSessionStats());
}

function cloneSessionStats(stats: SessionStats): SessionRecord["sessionStats"] {
  return {
    ...stats,
    tokens: {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      total: stats.tokens.total,
    },
    ...(stats.contextUsage ? { contextUsage: { ...stats.contextUsage } } : {}),
  };
}

function applyRuntimeErrorSnapshot(
  record: SessionRecord,
  runtimeErrorMessage: string | null,
): void {
  if (runtimeErrorMessage !== null && runtimeErrorMessage.length > 0) {
    record.errorMessage = runtimeErrorMessage;
    record.hasLocalCommandError = false;
    return;
  }

  if (!record.hasLocalCommandError) {
    record.errorMessage = null;
  }
}

function deriveRuntimeSessionStatus(
  session: NonNullable<AgentSessionRuntime["session"]>,
  errorMessage: string | null,
): SessionStatus {
  if (session.isCompacting) {
    return "compacting";
  }
  if (session.isRetrying) {
    return "retrying";
  }
  if (session.isStreaming) {
    return "running";
  }
  if (errorMessage !== null && errorMessage.length > 0) {
    return "error";
  }
  return "idle";
}

export function getRuntimeSessionFromRecord(
  record: SessionRecord,
): AgentSessionRuntime["session"] | undefined {
  const session = Reflect.get(record.runtime, "session");
  return isRuntimeSessionShape(session) ? session : undefined;
}

function readRuntimeExtensionMetadata(runtime: AgentSessionRuntime) {
  const runtimeMetadata = parseRuntimeExtensionMetadata(
    Reflect.get(runtime, "remoteExtensionMetadata"),
  );
  if (runtimeMetadata.length > 0) {
    return runtimeMetadata;
  }

  const session: unknown = Reflect.get(runtime, "session");
  if (session === null || typeof session !== "object") {
    return [];
  }

  const resourceLoader: unknown = Reflect.get(session, "resourceLoader");
  if (resourceLoader === null || typeof resourceLoader !== "object") {
    return [];
  }

  const getExtensions: unknown = Reflect.get(resourceLoader, "getExtensions");
  if (typeof getExtensions !== "function") {
    return [];
  }

  const loaded: unknown = getExtensions.call(resourceLoader);
  if (loaded === null || typeof loaded !== "object") {
    return [];
  }
  return parseResourceLoaderExtensionMetadata(Reflect.get(loaded, "extensions"));
}

function isRuntimeSessionShape(value: unknown): value is AgentSessionRuntime["session"] {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, "sessionManager") === "object" &&
    typeof Reflect.get(value, "settingsManager") === "object" &&
    typeof Reflect.get(value, "modelRegistry") === "object" &&
    typeof Reflect.get(value, "getActiveToolNames") === "function"
  );
}

export function requireRuntimeSessionFromRecord(
  record: SessionRecord,
): AgentSessionRuntime["session"] {
  const session = getRuntimeSessionFromRecord(record);
  if (!session) {
    throw new RemoteError("Session runtime is unavailable", 409);
  }
  return session;
}

export function getRequiredSessionRecord(
  sessions: Map<string, SessionRecord>,
  sessionId: string,
): SessionRecord {
  const record = sessions.get(sessionId);
  if (!record) {
    throw new RemoteError("Session not found", 404);
  }
  return record;
}

export function pruneExpiredSessionPresence(
  record: SessionRecord,
  now: number,
  presenceTtlMs: number,
): void {
  for (const [presenceKey, presence] of record.presence.entries()) {
    if (now - presence.lastSeenAt > presenceTtlMs) {
      record.presence.delete(presenceKey);
    }
  }
}

export function toSessionSnapshotRecord(
  record: SessionRecord,
  getHeadOffset: (streamId: string) => string,
): SessionSnapshot {
  const snapshotParts = buildSessionSnapshotParts(record);
  const streamOffsets = {
    lastSessionStreamOffset: getHeadOffset(sessionEventsStreamId(record.sessionId)),
    lastAppStreamOffsetSeenByServer: record.lastAppStreamOffsetSeenByServer,
  };
  return {
    ...snapshotParts,
    ...streamOffsets,
  };
}

export function parseModelRefStrict(model: string): { provider: string; modelId: string } | null {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    return null;
  }
  return {
    provider: model.slice(0, separator),
    modelId: model.slice(separator + 1),
  };
}

export function updateLastSeenOffsets(
  record: SessionRecord,
  getHeadOffset: (streamId: string) => string,
): void {
  record.lastAppStreamOffsetSeenByServer = getHeadOffset(appEventsStreamId());
  for (const presence of record.presence.values()) {
    presence.lastSeenAppOffset = getHeadOffset(appEventsStreamId());
    presence.lastSeenSessionOffset = getHeadOffset(sessionEventsStreamId(record.sessionId));
  }
}
