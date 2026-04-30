import type { AgentSessionRuntime, SessionStats } from "@mariozechner/pi-coding-agent";
import type { SessionSnapshot, SessionStatus } from "../schemas.js";
import { RemoteError } from "../errors.js";
import { appEventsStreamId, sessionEventsStreamId } from "../streams.js";
import { parseResourceLoaderExtensionMetadata, parseRuntimeExtensionMetadata } from "./helpers.js";
import {
  applyRuntimeResourcesSnapshot,
  readRuntimeSettingsSnapshot,
} from "./runtime-resources-sync.js";
import { buildSessionSnapshotParts } from "./runtime-sync-snapshot.js";
import { createEmptySessionStats, type SessionRecord } from "./types.js";

type RuntimeWithExtensionMetadata = AgentSessionRuntime & {
  remoteExtensionMetadata?: unknown;
};

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
  const previousInterruptedRuntimeDomains = { ...input.record.interruptedRuntimeDomains };
  applyRuntimeSnapshot(input.record, session, syncResources, previousInterruptedRuntimeDomains);
  input.record.interruptedRuntimeDomains = resolveInterruptedRuntimeDomains({
    previous: previousInterruptedRuntimeDomains,
    session,
    queueDepth: input.record.queue.depth,
  });
  if (updateTimestamp) {
    input.record.updatedAt = now;
  }

  if (input.record.activeRun) {
    if (updateTimestamp) {
      input.record.activeRun.updatedAt = now;
    }
    input.record.activeRun.queueDepth = input.record.queue.depth;
    input.record.activeRun.status = hasInterruptedRuntimeDomains(input.record)
      ? "interrupted"
      : input.record.status;
    if (
      !hasInterruptedRuntimeDomains(input.record) &&
      !session.isStreaming &&
      input.record.queue.depth === 0
    ) {
      input.record.activeRun = null;
    }
  }
}

function hasInterruptedRuntimeDomains(record: SessionRecord): boolean {
  return (
    record.interruptedRuntimeDomains.queue ||
    record.interruptedRuntimeDomains.retry ||
    record.interruptedRuntimeDomains.compaction ||
    record.interruptedRuntimeDomains.bash ||
    record.interruptedRuntimeDomains.streaming
  );
}

function applyRuntimeSnapshot(
  record: SessionRecord,
  session: NonNullable<AgentSessionRuntime["session"]>,
  syncResources: boolean,
  interruptedRuntimeDomains: SessionRecord["interruptedRuntimeDomains"],
): void {
  record.cwd = session.sessionManager.getCwd();
  record.extensions = readRuntimeExtensionMetadata(record.runtime);
  record.settings = readRuntimeSettingsSnapshot(session);
  if (syncResources) {
    applyRuntimeResourcesSnapshot(record, session);
  }
  applyRuntimeModelSnapshot(record, session);
  record.transcript = [...session.messages];
  if (session.isStreaming) {
    record.streamingState = "streaming";
  } else if (interruptedRuntimeDomains.streaming) {
    record.streamingState = "interrupted";
  } else {
    record.streamingState = "idle";
  }
  record.isBashRunning = session.isBashRunning;
  record.hasPendingBashMessages = session.hasPendingBashMessages;
  record.pendingToolCalls = [...session.state.pendingToolCalls.values()];
  applyRuntimeErrorSnapshot(record, session.state.errorMessage ?? null);
  if (session.isRetrying) {
    record.retry.status = "running";
  } else if (interruptedRuntimeDomains.retry) {
    record.retry.status = "interrupted";
  } else {
    record.retry.status = "idle";
  }

  if (session.isCompacting) {
    record.compaction.status = "running";
  } else if (interruptedRuntimeDomains.compaction) {
    record.compaction.status = "interrupted";
  } else {
    record.compaction.status = "idle";
  }
  record.queue.depth =
    session.pendingMessageCount +
    (session.isStreaming ? 1 : 0) +
    record.runtimeUndispatchedCommandCount;
  record.status = deriveRuntimeSessionStatus(session, record.errorMessage);
}

function resolveInterruptedRuntimeDomains(input: {
  previous: SessionRecord["interruptedRuntimeDomains"];
  session: NonNullable<AgentSessionRuntime["session"]>;
  queueDepth: number;
}): SessionRecord["interruptedRuntimeDomains"] {
  return {
    queue: input.queueDepth > 0 ? false : input.previous.queue,
    retry: input.previous.retry && !input.session.isRetrying,
    compaction: input.previous.compaction && !input.session.isCompacting,
    bash:
      input.previous.bash && !input.session.isBashRunning && !input.session.hasPendingBashMessages,
    streaming: input.previous.streaming && !input.session.isStreaming,
  };
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
  return record.runtime.session;
}

function readRuntimeExtensionMetadata(runtime: AgentSessionRuntime) {
  const runtimeMetadata = parseRuntimeExtensionMetadata(
    (runtime as RuntimeWithExtensionMetadata).remoteExtensionMetadata,
  );
  if (runtimeMetadata.length > 0) {
    return runtimeMetadata;
  }

  const session = runtime.session;
  if (session === undefined || session === null || typeof session !== "object") {
    return [];
  }

  const resourceLoader = session.resourceLoader;
  if (
    resourceLoader === undefined ||
    resourceLoader === null ||
    typeof resourceLoader !== "object"
  ) {
    return [];
  }

  const loaded = resourceLoader.getExtensions();
  if (loaded === undefined || loaded === null || typeof loaded !== "object") {
    return [];
  }

  return parseResourceLoaderExtensionMetadata(loaded.extensions);
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
  options?: { entriesLimit?: number; entriesOffset?: number },
): SessionSnapshot {
  const snapshotParts = buildSessionSnapshotParts(record, options);
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
