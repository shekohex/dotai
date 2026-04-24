import { randomUUID } from "node:crypto";
import type { AuthSession } from "../auth.js";
import { RemoteError } from "../errors.js";
import type {
  AppSnapshot,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionSnapshot,
  SessionSummary,
} from "../schemas.js";
import { appEventsStreamId, sessionEventsStreamId } from "../streams.js";
import {
  createSingleSession,
  detachSessionPresence,
  disposeFailedSessionCreation,
  disposeSessionRegistry,
  enqueueSessionCreation,
  getAppSnapshot,
  getLastAppStreamOffsetForNewSession,
  getLastSessionStreamOffset,
  getSessionSnapshot,
  registerCreatedSession,
  touchSessionPresence,
  type SessionRecord,
} from "./deps.js";
import { SessionRegistryBase } from "./registry-base.js";

export class SessionRegistryManagement extends SessionRegistryBase {
  createSession(
    input: CreateSessionRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CreateSessionResponse> {
    const queued = enqueueSessionCreation({
      currentQueue: this.sessionCreationQueue,
      operation: () => this.createSessionOperation(input, client, connectionId),
    });
    this.sessionCreationQueue = queued.nextQueue;
    return queued.pending;
  }

  protected createSessionOperation(
    request: CreateSessionRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CreateSessionResponse> {
    return createSingleSession({
      request,
      client,
      connectionId,
      sessions: this.getLoadedSessions(),
      now: this.now,
      createSessionId: () => randomUUID(),
      createRuntime: (runtimeRequest) => this.runtimeFactory.create(runtimeRequest),
      readRuntimeExtensionMetadata: (runtime) => this.readRuntimeExtensionMetadata(runtime),
      getLastAppStreamOffset: () =>
        getLastAppStreamOffsetForNewSession((streamId) => this.streams.getHeadOffset(streamId)),
      initializeRuntimeSession: async (record, createdAt) => {
        await this.initializeRuntimeRecord(record, {
          initializedAt: createdAt,
          syncSessionNameToRuntime: true,
          flushPersistedSessionManager: true,
        });
      },
      registerCreatedSession: (record, targetClient, targetConnectionId, createdAt) => {
        this.registerCreatedSessionRecord(record, targetClient, targetConnectionId, createdAt);
      },
      disposeFailedSessionCreation: async (sessionId, runtime) => {
        await disposeFailedSessionCreation({
          sessions: this.getLoadedSessions(),
          sessionId,
          runtime,
        });
      },
    });
  }

  protected registerCreatedSessionRecord(
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    createdAt: number,
  ): void {
    registerCreatedSession({
      sessions: this.getLoadedSessions(),
      record,
      client,
      connectionId,
      createdAt,
      ensureSessionStream: (targetSessionId) => {
        this.streams.ensureStream(sessionEventsStreamId(targetSessionId));
      },
      appendSessionCreatedEvent: (targetSessionId, payload, ts) =>
        this.streams.append(appEventsStreamId(), {
          sessionId: targetSessionId,
          kind: "session_created",
          payload,
          ts,
        }),
      touchPresence: (targetSessionId, presenceClient, presenceConnectionId) => {
        this.touchPresence(targetSessionId, presenceClient, presenceConnectionId);
      },
    });
  }

  getSessionSnapshot(
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
  ): SessionSnapshot {
    const record = this.getRequired(sessionId);
    return getSessionSnapshot({
      sessionId,
      client,
      connectionId,
      record,
      touchPresence: (targetSessionId, targetClient, targetConnectionId) => {
        this.touchPresence(targetSessionId, targetClient, targetConnectionId);
      },
      syncFromRuntime: (targetRecord) => {
        this.syncFromRuntime(targetRecord, { updateTimestamp: false, syncResources: true });
      },
      toSessionSnapshot: (targetRecord) => this.toSessionSnapshot(targetRecord),
    });
  }

  async loadSessionSnapshot(
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
  ): Promise<SessionSnapshot> {
    await this.ensureLoaded(sessionId);
    return this.getSessionSnapshot(sessionId, client, connectionId);
  }

  async reload(
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
  ): Promise<SessionSnapshot> {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    this.syncFromRuntime(record, { updateTimestamp: false });
    const session = this.requireRuntimeSession(record);
    if (session.isStreaming) {
      throw new RemoteError("Wait for current response to finish before reloading.", 409);
    }
    if (session.isCompacting) {
      throw new RemoteError("Wait for compaction to finish before reloading.", 409);
    }
    if (record.queue.depth > 0) {
      throw new RemoteError("Wait for queued commands to finish before reloading.", 409);
    }
    await session.reload();
    return this.getSessionSnapshot(sessionId, client, connectionId);
  }

  async getSessionTools(
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
  ): Promise<
    Array<{
      name: string;
      description: string;
      parameters: unknown;
      sourceInfo: unknown;
    }>
  > {
    const record = await this.ensureLoaded(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    this.syncFromRuntime(record, { updateTimestamp: false, syncResources: true });
    const session = this.getRuntimeSession(record);
    if (!session) {
      return record.activeTools.map((toolName) => ({
        name: toolName,
        description: `${toolName} tool`,
        parameters: {},
        sourceInfo: {
          source: "remote",
        },
      }));
    }

    return session.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      sourceInfo: tool.sourceInfo,
    }));
  }

  getAppSnapshot(client: AuthSession): AppSnapshot {
    return getAppSnapshot({
      client,
      now: this.now,
      listSessionSummaries: () => this.listSessionSummaries(),
    });
  }

  listSessionSummaries(): SessionSummary[] {
    return this.catalog.listSummaries({
      sessions: this.getLoadedSessions(),
      syncFromRuntime: (record) => {
        this.syncFromRuntime(record, { updateTimestamp: false });
      },
      getLastSessionStreamOffset: (sessionId) =>
        getLastSessionStreamOffset((streamId) => this.streams.getHeadOffset(streamId), sessionId),
    });
  }

  getSessionSummary(sessionId: string): SessionSummary {
    const summary = this.catalog.getSummary({
      sessionId,
      sessions: this.getLoadedSessions(),
      syncFromRuntime: (record) => {
        this.syncFromRuntime(record, { updateTimestamp: false });
      },
      getLastSessionStreamOffset: (targetSessionId) =>
        getLastSessionStreamOffset(
          (streamId) => this.streams.getHeadOffset(streamId),
          targetSessionId,
        ),
    });
    if (!summary) {
      throw new RemoteError("Session not found", 404);
    }
    return summary;
  }

  touchPresence(sessionId: string, client: AuthSession, connectionId?: string): void {
    const record = this.getRequired(sessionId);
    touchSessionPresence({
      record,
      client,
      connectionId,
      now: this.now(),
      createConnectionId: () => randomUUID(),
      pruneExpiredPresence: (targetRecord, now) => {
        this.pruneExpiredPresence(targetRecord, now);
      },
      readConnectionCapabilities: (targetClientId, targetConnectionId) =>
        this.readConnectionCapabilities(targetClientId, targetConnectionId),
      getLastAppOffset: () => this.streams.getHeadOffset(appEventsStreamId()),
      getLastSessionOffset: (targetSessionId) =>
        this.streams.getHeadOffset(sessionEventsStreamId(targetSessionId)),
    });
  }

  detachPresence(sessionId: string, connectionId: string): void {
    const record = this.getRequired(sessionId);
    detachSessionPresence(record, connectionId);
  }

  async dispose(): Promise<void> {
    await disposeSessionRegistry({
      sessions: this.getLoadedSessions(),
      disposeRuntimeFactory: async () => {
        await this.runtimeFactory.dispose();
      },
    });
  }
}
