import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
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

export function createSessionRecord(input: {
  sessionId: string;
  sessionName: string;
  createdAt: number;
  updatedAt?: number;
  runtime: AgentSessionRuntime;
  lastAppStreamOffsetSeenByServer: string;
  readRuntimeExtensionMetadata: (runtime: AgentSessionRuntime) => SessionRecord["extensions"];
}): SessionRecord {
  return {
    sessionId: input.sessionId,
    sessionName: input.sessionName,
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
    updatedAt: input.updatedAt ?? input.createdAt,
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
  createRuntime: (request?: { cwd?: string }) => Promise<AgentSessionRuntime>;
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
  const createdAt = input.now();
  const runtime = await input.createRuntime({ cwd: input.request.workspaceCwd });
  const sessionId = readRuntimeSessionId(runtime) ?? input.createSessionId();
  try {
    const record = createSessionRecord({
      sessionId,
      sessionName: input.request.sessionName ?? `Session ${input.sessions.size + 1}`,
      createdAt,
      updatedAt: createdAt,
      runtime,
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

function readRuntimeSessionId(runtime: AgentSessionRuntime): string | undefined {
  const sessionId = runtime.session?.sessionManager.getSessionId();
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

export function getAppSnapshot(input: {
  client: AuthSession;
  now: () => number;
  listSessionSummaries: () => SessionSummary[];
}): AppSnapshot {
  const sessionSummaries = input.listSessionSummaries();
  const defaultAttachSessionId = sessionSummaries.find(
    (sessionSummary) => sessionSummary.lifecycle.loaded,
  )?.sessionId;
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
    sessionSummaries,
    recentNotices: [],
    defaultAttachSessionId,
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
