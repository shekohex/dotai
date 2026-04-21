import { randomUUID } from "node:crypto";
import type { AuthSession } from "../auth.js";
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
  listSessionSummaries,
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
      sessions: this.sessions,
      now: this.now,
      createSessionId: () => randomUUID(),
      createRuntime: () => this.runtimeFactory.create(),
      readRuntimeExtensionMetadata: (runtime) => this.readRuntimeExtensionMetadata(runtime),
      getLastAppStreamOffset: () =>
        getLastAppStreamOffsetForNewSession((streamId) => this.streams.getHeadOffset(streamId)),
      initializeRuntimeSession: async (record, createdAt) => {
        await this.initializeRuntimeSession(record, createdAt);
      },
      registerCreatedSession: (record, targetClient, targetConnectionId, createdAt) => {
        this.registerCreatedSessionRecord(record, targetClient, targetConnectionId, createdAt);
      },
      disposeFailedSessionCreation: async (sessionId, runtime) => {
        await disposeFailedSessionCreation({
          sessions: this.sessions,
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
      sessions: this.sessions,
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

  protected async initializeRuntimeSession(
    record: SessionRecord,
    createdAt: number,
  ): Promise<void> {
    const session = this.getRuntimeSession(record);
    if (!session) {
      return;
    }

    await session.bindExtensions({
      uiContext: this.createRemoteUiContext(record),
    });
    this.syncFromRuntime(record, { now: createdAt, updateTimestamp: false });
    record.runtimeSubscription = session.subscribe((event) => {
      this.handleSessionEvent(record.sessionId, event);
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
        this.syncFromRuntime(targetRecord, { updateTimestamp: false });
      },
      toSessionSnapshot: (targetRecord) => this.toSessionSnapshot(targetRecord),
    });
  }

  getAppSnapshot(client: AuthSession): AppSnapshot {
    return getAppSnapshot({
      client,
      now: this.now,
      sessions: this.sessions,
      listSessionSummaries: () => this.listSessionSummaries(),
    });
  }

  listSessionSummaries(): SessionSummary[] {
    return listSessionSummaries({
      sessions: this.sessions,
      syncFromRuntime: (record) => {
        this.syncFromRuntime(record, { updateTimestamp: false });
      },
      getLastSessionStreamOffset: (sessionId) =>
        getLastSessionStreamOffset((streamId) => this.streams.getHeadOffset(streamId), sessionId),
    });
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
      sessions: this.sessions,
      disposeRuntimeFactory: async () => {
        await this.runtimeFactory.dispose();
      },
    });
  }
}
