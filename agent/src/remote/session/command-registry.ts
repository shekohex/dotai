import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { RemoteError } from "../errors.js";
import type {
  AppSnapshot,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionSnapshot,
  SessionSummary,
} from "../schemas.js";
import { appEventsStreamId, sessionEventsStreamId } from "../streams.js";
import type { AuthSession } from "../auth.js";
import {
  createEmptyResourceBundle,
  createEmptySettingsSnapshot,
  createEmptyModelSettings,
  createIdleTaskState,
  createInitialQueue,
  createEmptySessionStats,
  type SessionRecord,
} from "./types.js";

export function enqueueSessionCreation<T>(input: {
  currentQueue: Promise<void>;
  operation: () => Promise<T>;
}): {
  pending: Promise<T>;
  nextQueue: Promise<void>;
} {
  const pending = input.currentQueue.then(input.operation);
  const nextQueue = pending.then(
    () => {},
    () => {},
  );
  return { pending, nextQueue };
}

function buildSessionRecord(input: {
  sessionId: string;
  request: CreateSessionRequest;
  createdAt: number;
  runtime: AgentSessionRuntime;
  existingSessionCount: number;
  lastAppStreamOffsetSeenByServer: string;
  readRuntimeExtensionMetadata: (runtime: AgentSessionRuntime) => SessionRecord["extensions"];
}): SessionRecord {
  return {
    sessionId: input.sessionId,
    sessionName: input.request.sessionName ?? `Session ${input.existingSessionCount + 1}`,
    status: "idle",
    cwd: "",
    model: "pi-remote-faux/pi-remote-faux-1",
    thinkingLevel: "medium",
    activeTools: ["read", "bash", "edit", "write"],
    extensions: input.readRuntimeExtensionMetadata(input.runtime),
    resources: createEmptyResourceBundle(),
    settings: createEmptySettingsSnapshot(),
    availableModels: [],
    modelSettings: createEmptyModelSettings(),
    contextUsage: undefined,
    usageCost: 0,
    sessionStats: createEmptySessionStats(input.sessionId),
    autoCompactionEnabled: false,
    steeringMode: "all",
    followUpMode: "all",
    transcript: [],
    queue: createInitialQueue(),
    retry: createIdleTaskState(),
    compaction: createIdleTaskState(),
    activeRun: null,
    streamingState: "idle",
    pendingToolCalls: [],
    errorMessage: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    lastAppStreamOffsetSeenByServer: input.lastAppStreamOffsetSeenByServer,
    presence: new Map(),
    runtime: input.runtime,
    commandAcceptanceQueue: Promise.resolve(),
    runtimeDispatchQueue: Promise.resolve(),
    runtimeUndispatchedCommandCount: 0,
    hasLocalCommandError: false,
    pendingUiRequests: new Map(),
  };
}

function toCreateSessionResponse(record: SessionRecord): CreateSessionResponse {
  return {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    status: record.status,
  };
}

export async function createSingleSession(input: {
  request: CreateSessionRequest;
  client: AuthSession;
  connectionId?: string;
  sessions: Map<string, SessionRecord>;
  now: () => number;
  createSessionId: () => string;
  createRuntime: () => Promise<AgentSessionRuntime>;
  readRuntimeExtensionMetadata: (runtime: AgentSessionRuntime) => SessionRecord["extensions"];
  getLastAppStreamOffset: () => string;
  initializeRuntimeSession: (record: SessionRecord, createdAt: number) => Promise<void>;
  registerCreatedSession: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    createdAt: number,
  ) => void;
  disposeFailedSessionCreation: (sessionId: string, runtime: AgentSessionRuntime) => Promise<void>;
}): Promise<CreateSessionResponse> {
  if (input.sessions.size > 0) {
    throw new RemoteError("Milestone 1 supports only one in-memory session", 409);
  }

  const createdAt = input.now();
  const sessionId = input.createSessionId();
  const runtime = await input.createRuntime();
  try {
    const record = buildSessionRecord({
      sessionId,
      request: input.request,
      createdAt,
      runtime,
      existingSessionCount: input.sessions.size,
      lastAppStreamOffsetSeenByServer: input.getLastAppStreamOffset(),
      readRuntimeExtensionMetadata: input.readRuntimeExtensionMetadata,
    });
    await input.initializeRuntimeSession(record, createdAt);
    input.registerCreatedSession(record, input.client, input.connectionId, createdAt);
    return toCreateSessionResponse(record);
  } catch (error) {
    await input.disposeFailedSessionCreation(sessionId, runtime);
    throw error;
  }
}

export function listSessionSummaries(input: {
  sessions: Map<string, SessionRecord>;
  syncFromRuntime: (record: SessionRecord) => void;
  getLastSessionStreamOffset: (sessionId: string) => string;
}): SessionSummary[] {
  return [...input.sessions.values()].map((record) => {
    input.syncFromRuntime(record);
    return {
      sessionId: record.sessionId,
      sessionName: record.sessionName,
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastSessionStreamOffset: input.getLastSessionStreamOffset(record.sessionId),
    };
  });
}

export function getAppSnapshot(input: {
  client: AuthSession;
  now: () => number;
  sessions: Map<string, SessionRecord>;
  listSessionSummaries: () => SessionSummary[];
}): AppSnapshot {
  return {
    serverInfo: {
      name: "pi-remote",
      version: "0.1.0",
      now: input.now(),
    },
    currentClientAuthInfo: {
      clientId: input.client.clientId,
      keyId: input.client.keyId,
      tokenExpiresAt: input.client.expiresAt,
    },
    sessionSummaries: input.listSessionSummaries(),
    recentNotices: [],
    defaultAttachSessionId: input.sessions.values().next().value?.sessionId,
  };
}

export function getSessionSnapshot(input: {
  sessionId: string;
  client: AuthSession;
  connectionId?: string;
  record: SessionRecord;
  touchPresence: (sessionId: string, client: AuthSession, connectionId?: string) => void;
  syncFromRuntime: (record: SessionRecord) => void;
  toSessionSnapshot: (record: SessionRecord) => SessionSnapshot;
}): SessionSnapshot {
  input.touchPresence(input.sessionId, input.client, input.connectionId);
  input.syncFromRuntime(input.record);
  return input.toSessionSnapshot(input.record);
}

export function registerCreatedSession(input: {
  sessions: Map<string, SessionRecord>;
  record: SessionRecord;
  client: AuthSession;
  connectionId?: string;
  createdAt: number;
  ensureSessionStream: (sessionId: string) => void;
  appendSessionCreatedEvent: (
    sessionId: string,
    payload: {
      sessionId: string;
      sessionName: string;
      status: SessionRecord["status"];
    },
    ts: number,
  ) => { streamOffset: string };
  touchPresence: (sessionId: string, client: AuthSession, connectionId?: string) => void;
}): void {
  input.sessions.set(input.record.sessionId, input.record);
  input.ensureSessionStream(input.record.sessionId);
  const event = input.appendSessionCreatedEvent(
    input.record.sessionId,
    {
      sessionId: input.record.sessionId,
      sessionName: input.record.sessionName,
      status: input.record.status,
    },
    input.createdAt,
  );
  input.record.lastAppStreamOffsetSeenByServer = event.streamOffset;
  input.touchPresence(input.record.sessionId, input.client, input.connectionId);
}

export async function disposeFailedSessionCreation(input: {
  sessions: Map<string, SessionRecord>;
  sessionId: string;
  runtime: AgentSessionRuntime;
}): Promise<void> {
  input.sessions.delete(input.sessionId);
  await input.runtime.dispose();
}

export function getLastAppStreamOffsetForNewSession(
  getHeadOffset: (streamId: string) => string,
): string {
  return getHeadOffset(appEventsStreamId());
}

export function getLastSessionStreamOffset(
  getHeadOffset: (streamId: string) => string,
  sessionId: string,
): string {
  return getHeadOffset(sessionEventsStreamId(sessionId));
}
