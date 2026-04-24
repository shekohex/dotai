import { randomUUID } from "node:crypto";
import type { AuthSession } from "../auth.js";
import { RemoteError } from "../errors.js";
import type { SessionCatalogRecord } from "../session-catalog.js";
import type {
  AppSnapshot,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionDeletedResponse,
  SessionSnapshot,
  SessionSummary,
} from "../schemas.js";
import { appEventsStreamId, sessionEventsStreamId } from "../streams.js";
import {
  createSingleSession,
  detachSessionPresence,
  disposeSessionRecord,
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

  async evictIdleRuntimes(): Promise<string[]> {
    const evictedSessionIds: string[] = [];
    const evictedAt = this.now();
    const canReloadPersistedSessions = typeof this.runtimeFactory.load === "function";

    for (const record of this.loadedRuntimes.values()) {
      if (
        !shouldEvictLoadedRuntime(
          record,
          evictedAt,
          this.runtimeIdleTtlMs,
          canReloadPersistedSessions,
        )
      ) {
        continue;
      }

      await disposeSessionRecord(record);
      this.loadedRuntimes.delete(record.sessionId);
      evictedSessionIds.push(record.sessionId);
      this.streams.append(appEventsStreamId(), {
        sessionId: record.sessionId,
        kind: "session_summary_updated",
        payload: {
          sessionId: record.sessionId,
          sessionName: record.sessionName,
          status: "idle",
          updatedAt: evictedAt,
        },
        ts: evictedAt,
      });
    }

    return evictedSessionIds;
  }

  async reconcileCatalogFromDisk(): Promise<void> {
    const previousRecords = new Map(
      this.catalog.list().map((record) => [record.sessionId, record]),
    );
    this.catalog.scan();
    const nextRecords = new Map(this.catalog.list().map((record) => [record.sessionId, record]));
    const reconciledAt = this.now();

    for (const [sessionId, previousRecord] of previousRecords.entries()) {
      const nextRecord = nextRecords.get(sessionId);
      if (nextRecord) {
        if (!didCatalogRecordChange(previousRecord, nextRecord)) {
          continue;
        }
        await this.handleChangedCatalogRecord(sessionId, previousRecord, nextRecord, reconciledAt);
        continue;
      }

      const loaded = this.loadedRuntimes.get(sessionId);
      if (loaded) {
        if (this.markLoadedRuntimeConflictedIfBusy(loaded, reconciledAt)) {
          this.streams.append(appEventsStreamId(), {
            sessionId,
            kind: "session_summary_updated",
            payload: {
              sessionId,
              sessionName: loaded.sessionName,
              status: loaded.status,
              updatedAt: loaded.updatedAt,
            },
            ts: reconciledAt,
          });
          continue;
        }

        await disposeSessionRecord(loaded);
        this.loadedRuntimes.delete(sessionId);
      }
      this.streams.append(appEventsStreamId(), {
        sessionId,
        kind: "session_closed",
        payload: { sessionId },
        ts: reconciledAt,
      });
    }

    for (const [sessionId, nextRecord] of nextRecords.entries()) {
      if (previousRecords.has(sessionId)) {
        continue;
      }
      this.streams.append(appEventsStreamId(), {
        sessionId,
        kind: "session_summary_updated",
        payload: {
          sessionId,
          sessionName: nextRecord.sessionName,
          status: "idle",
          updatedAt: nextRecord.modifiedAt,
        },
        ts: reconciledAt,
      });
    }
  }

  async archiveSession(sessionId: string): Promise<SessionSummary> {
    if (!this.catalog.get(sessionId)) {
      throw new RemoteError("Session not found", 404);
    }
    const loaded = this.loadedRuntimes.get(sessionId);
    if (loaded) {
      await disposeSessionRecord(loaded);
      this.loadedRuntimes.delete(sessionId);
    }
    const archivedRecord = this.catalog.archive(sessionId);
    this.streams.append(appEventsStreamId(), {
      sessionId,
      kind: "session_summary_updated",
      payload: {
        sessionId,
        sessionName: archivedRecord.sessionName,
        status: "idle",
        updatedAt: archivedRecord.modifiedAt,
      },
      ts: this.now(),
    });
    return this.getSessionSummary(sessionId);
  }

  restoreSession(sessionId: string): SessionSummary {
    if (!this.catalog.get(sessionId)) {
      throw new RemoteError("Session not found", 404);
    }
    const restoredRecord = this.catalog.restore(sessionId);
    this.streams.append(appEventsStreamId(), {
      sessionId,
      kind: "session_summary_updated",
      payload: {
        sessionId,
        sessionName: restoredRecord.sessionName,
        status: "idle",
        updatedAt: restoredRecord.modifiedAt,
      },
      ts: this.now(),
    });
    return this.getSessionSummary(sessionId);
  }

  async deleteSession(sessionId: string): Promise<SessionDeletedResponse> {
    if (!this.catalog.get(sessionId) && !this.loadedRuntimes.get(sessionId)) {
      throw new RemoteError("Session not found", 404);
    }
    const loaded = this.loadedRuntimes.get(sessionId);
    if (loaded) {
      await disposeSessionRecord(loaded);
      this.loadedRuntimes.delete(sessionId);
    }
    if (this.catalog.get(sessionId)) {
      this.catalog.delete(sessionId);
    }
    this.streams.append(appEventsStreamId(), {
      sessionId,
      kind: "session_closed",
      payload: { sessionId },
      ts: this.now(),
    });
    return {
      sessionId,
      deleted: true,
    };
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
      onPresencePrunedToZero: (targetRecord) => {
        if (targetRecord.persistence === "ephemeral") {
          this.scheduleEphemeralSessionCleanup(targetRecord.sessionId);
        }
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
    if (record.persistence === "ephemeral" && record.presence.size === 0) {
      this.scheduleEphemeralSessionCleanup(sessionId);
    }
  }

  async dispose(): Promise<void> {
    await disposeSessionRegistry({
      sessions: this.getLoadedSessions(),
      disposeRuntimeFactory: async () => {
        await this.runtimeFactory.dispose();
      },
    });
  }

  private async handleChangedCatalogRecord(
    sessionId: string,
    previousRecord: SessionCatalogRecord,
    nextRecord: SessionCatalogRecord,
    reconciledAt: number,
  ): Promise<void> {
    const loaded = this.loadedRuntimes.get(sessionId);
    if (loaded) {
      await this.reconcileLoadedRuntimeForCatalogChange(
        loaded,
        previousRecord,
        nextRecord,
        reconciledAt,
      );
    }

    const summary = loaded ? this.getSessionSummary(sessionId) : undefined;
    this.streams.append(appEventsStreamId(), {
      sessionId,
      kind: "session_summary_updated",
      payload: {
        sessionId,
        sessionName: summary?.sessionName ?? nextRecord.sessionName,
        status: summary?.status ?? "idle",
        updatedAt: summary?.updatedAt ?? nextRecord.modifiedAt,
      },
      ts: reconciledAt,
    });
  }

  private async reconcileLoadedRuntimeForCatalogChange(
    record: SessionRecord,
    previousRecord: SessionCatalogRecord,
    nextRecord: SessionCatalogRecord,
    reconciledAt: number,
  ): Promise<void> {
    const session = this.requireRuntimeSession(record);
    if (didCatalogLocationChange(previousRecord, nextRecord)) {
      if (this.markLoadedRuntimeConflictedIfBusy(record, reconciledAt)) {
        return;
      }

      await disposeSessionRecord(record);
      this.loadedRuntimes.delete(record.sessionId);
      return;
    }

    if (this.markLoadedRuntimeConflictedIfBusy(record, reconciledAt)) {
      return;
    }

    await session.reload();
    this.syncFromRuntime(record, {
      now: Math.max(reconciledAt, nextRecord.modifiedAt),
      updateTimestamp: false,
      syncResources: true,
    });
    record.sessionName = nextRecord.sessionName;
    record.cwd = nextRecord.cwd;
    record.createdAt = nextRecord.createdAt;
    record.updatedAt = Math.max(record.updatedAt, nextRecord.modifiedAt);
    record.errorMessage = null;
    record.hasLocalCommandError = false;
  }

  private markLoadedRuntimeConflictedIfBusy(record: SessionRecord, reconciledAt: number): boolean {
    const session = this.requireRuntimeSession(record);
    if (!isRuntimeSessionBusy(record, session)) {
      return false;
    }

    record.errorMessage = "Session changed externally while runtime active. Reload required.";
    record.hasLocalCommandError = true;
    record.updatedAt = reconciledAt;
    return true;
  }

  private async deleteEphemeralSession(sessionId: string): Promise<void> {
    const record = this.loadedRuntimes.get(sessionId);
    if (!record || record.persistence !== "ephemeral" || record.presence.size > 0) {
      return;
    }

    await disposeSessionRecord(record);
    this.streams.append(appEventsStreamId(), {
      sessionId,
      kind: "session_closed",
      payload: { sessionId },
      ts: this.now(),
    });
    this.loadedRuntimes.delete(sessionId);
  }

  private scheduleEphemeralSessionCleanup(sessionId: string): void {
    void this.deleteEphemeralSession(sessionId).catch((error: unknown) => {
      const record = this.loadedRuntimes.get(sessionId);
      if (!record) {
        return;
      }

      const updatedAt = this.now();
      record.errorMessage = formatEphemeralCleanupError(error);
      record.hasLocalCommandError = true;
      record.updatedAt = updatedAt;
      this.emitSessionSummaryUpdated(record, updatedAt);
    });
  }
}

function formatEphemeralCleanupError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return `Failed to clean up ephemeral session: ${error.message}`;
  }
  return "Failed to clean up ephemeral session.";
}

function didCatalogRecordChange(
  previousRecord: SessionCatalogRecord,
  nextRecord: SessionCatalogRecord,
): boolean {
  return (
    previousRecord.sessionPath !== nextRecord.sessionPath ||
    previousRecord.cwd !== nextRecord.cwd ||
    previousRecord.sessionName !== nextRecord.sessionName ||
    previousRecord.modifiedAt !== nextRecord.modifiedAt ||
    previousRecord.parentSessionId !== nextRecord.parentSessionId ||
    previousRecord.lifecycleStatus !== nextRecord.lifecycleStatus
  );
}

function didCatalogLocationChange(
  previousRecord: SessionCatalogRecord,
  nextRecord: SessionCatalogRecord,
): boolean {
  return (
    previousRecord.sessionPath !== nextRecord.sessionPath ||
    previousRecord.lifecycleStatus !== nextRecord.lifecycleStatus
  );
}

function isRuntimeSessionBusy(
  record: SessionRecord,
  session: NonNullable<SessionRecord["runtime"]>["session"],
): boolean {
  return session.isStreaming || session.isCompacting || record.queue.depth > 0;
}

function shouldEvictLoadedRuntime(
  record: SessionRecord,
  now: number,
  runtimeIdleTtlMs: number | undefined,
  canReloadPersistedSessions: boolean,
): boolean {
  if (record.persistence !== "persistent") {
    return false;
  }
  if (!canReloadPersistedSessions) {
    return false;
  }
  if (record.presence.size > 0) {
    return false;
  }
  const session = record.runtime.session;
  if (session === undefined) {
    return false;
  }
  if (isRuntimeSessionBusy(record, session)) {
    return false;
  }
  if (runtimeIdleTtlMs === undefined) {
    return false;
  }
  return now - record.updatedAt >= runtimeIdleTtlMs;
}
