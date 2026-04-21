import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { SessionSnapshot, SessionStatus } from "../schemas.js";
import { RemoteError } from "../errors.js";
import { appEventsStreamId, sessionEventsStreamId } from "../streams.js";
import { parseResourceLoaderExtensionMetadata, parseRuntimeExtensionMetadata } from "./helpers.js";
import type { SessionRecord } from "./types.js";

export function syncSessionRecordFromRuntime(input: {
  record: SessionRecord;
  now: () => number;
  options?: {
    now?: number;
    updateTimestamp?: boolean;
  };
  getRuntimeSession: (record: SessionRecord) => AgentSessionRuntime["session"] | undefined;
}): void {
  const session = input.getRuntimeSession(input.record);
  if (!session) {
    return;
  }

  const now = input.options?.now ?? input.now();
  const updateTimestamp = input.options?.updateTimestamp ?? true;
  applyRuntimeSnapshot(input.record, session);
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
): void {
  record.cwd = session.sessionManager.getCwd();
  record.extensions = readRuntimeExtensionMetadata(record.runtime);
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

function buildSessionSnapshotParts(
  record: SessionRecord,
): Omit<SessionSnapshot, "lastSessionStreamOffset" | "lastAppStreamOffsetSeenByServer"> {
  const modelSettings = buildModelSettingsSnapshot(record);
  const draft = buildDraftSnapshot(record);
  const queue = {
    depth: record.queue.depth,
    nextSequence: record.queue.nextSequence,
  };
  return {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    status: record.status,
    cwd: record.cwd,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    activeTools: [...record.activeTools],
    extensions: record.extensions.map((extension) => ({ ...extension })),
    availableModels: record.availableModels.map((model) => ({ ...model })),
    modelSettings,
    draft,
    draftRevision: record.draft.revision,
    transcript: [...record.transcript],
    queue,
    retry: {
      status: record.retry.status,
    },
    compaction: {
      status: record.compaction.status,
    },
    presence: [...record.presence.values()],
    activeRun: record.activeRun,
    streamingState: record.streamingState,
    pendingToolCalls: [...record.pendingToolCalls],
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildModelSettingsSnapshot(record: SessionRecord): SessionSnapshot["modelSettings"] {
  return {
    defaultProvider: record.modelSettings.defaultProvider,
    defaultModel: record.modelSettings.defaultModel,
    defaultThinkingLevel: record.modelSettings.defaultThinkingLevel,
    enabledModels: record.modelSettings.enabledModels
      ? [...record.modelSettings.enabledModels]
      : null,
  };
}

function buildDraftSnapshot(record: SessionRecord): SessionSnapshot["draft"] {
  return {
    text: record.draft.text,
    attachments: [...record.draft.attachments],
    revision: record.draft.revision,
    updatedAt: record.draft.updatedAt,
    updatedByClientId: record.draft.updatedByClientId,
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
