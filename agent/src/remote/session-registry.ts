import { randomUUID } from "node:crypto";
import { RemoteError } from "./errors.js";
import type { AuthSession } from "./auth.js";
import type {
  AppSnapshot,
  CreateSessionRequest,
  CreateSessionResponse,
  Presence,
  SessionStatus,
  SessionSnapshot,
  SessionSummary,
} from "./schemas.js";
import { InMemoryDurableStreamStore, appEventsStreamId, sessionEventsStreamId } from "./streams.js";
import type { RemoteRuntimeFactory } from "./runtime-factory.js";

interface SessionRecord {
  sessionId: string;
  sessionName: string;
  status: SessionStatus;
  model: string;
  thinkingLevel: string;
  activeTools: string[];
  draft: {
    text: string;
    attachments: string[];
    revision: number;
    updatedAt: number;
    updatedByClientId: string | null;
  };
  transcript: unknown[];
  queue: {
    depth: number;
    nextSequence: number;
  };
  retry: {
    status: string;
  };
  compaction: {
    status: string;
  };
  activeRun: SessionSnapshot["activeRun"];
  streamingState: string;
  pendingToolCalls: unknown[];
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  lastAppStreamOffsetSeenByServer: string;
  presence: Map<string, Presence>;
  runtime: {
    dispose: () => Promise<void>;
  };
}

interface SessionRegistryOptions {
  streams: InMemoryDurableStreamStore;
  runtimeFactory: RemoteRuntimeFactory;
  presenceTtlMs?: number;
  now?: () => number;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly streams: InMemoryDurableStreamStore;
  private readonly runtimeFactory: RemoteRuntimeFactory;
  private readonly presenceTtlMs: number;
  private readonly now: () => number;
  private sessionCreationQueue: Promise<void> = Promise.resolve();

  constructor(options: SessionRegistryOptions) {
    this.streams = options.streams;
    this.runtimeFactory = options.runtimeFactory;
    this.presenceTtlMs = options.presenceTtlMs ?? 120_000;
    this.now = options.now ?? (() => Date.now());
    this.streams.ensureStream(appEventsStreamId());
  }

  async createSession(
    input: CreateSessionRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CreateSessionResponse> {
    return this.enqueueSessionCreation(async () => {
      if (this.sessions.size >= 1) {
        throw new RemoteError("Milestone 1 supports only one in-memory session", 409);
      }

      const createdAt = this.now();
      const sessionId = randomUUID();
      const runtime = await this.runtimeFactory.create();

      const record: SessionRecord = {
        sessionId,
        sessionName: input.sessionName ?? `Session ${this.sessions.size + 1}`,
        status: "idle",
        model: "pi-remote-faux/pi-remote-faux-1",
        thinkingLevel: "medium",
        activeTools: ["read", "bash", "edit", "write"],
        draft: {
          text: "",
          attachments: [],
          revision: 0,
          updatedAt: createdAt,
          updatedByClientId: null,
        },
        transcript: [],
        queue: {
          depth: 0,
          nextSequence: 1,
        },
        retry: {
          status: "idle",
        },
        compaction: {
          status: "idle",
        },
        activeRun: null,
        streamingState: "idle",
        pendingToolCalls: [],
        errorMessage: null,
        createdAt,
        updatedAt: createdAt,
        lastAppStreamOffsetSeenByServer: this.streams.getHeadOffset(appEventsStreamId()),
        presence: new Map(),
        runtime,
      };

      this.sessions.set(sessionId, record);
      this.streams.ensureStream(sessionEventsStreamId(sessionId));
      const event = this.streams.append(appEventsStreamId(), {
        sessionId,
        kind: "session_created",
        payload: {
          sessionId,
          sessionName: record.sessionName,
          status: record.status,
        },
        ts: createdAt,
      });
      record.lastAppStreamOffsetSeenByServer = event.streamOffset;
      this.touchPresence(sessionId, client, connectionId);

      return {
        sessionId,
        sessionName: record.sessionName,
        status: record.status,
      };
    });
  }

  private enqueueSessionCreation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sessionCreationQueue.then(operation);
    this.sessionCreationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  getSessionSnapshot(
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
  ): SessionSnapshot {
    const record = this.getRequired(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    return this.toSessionSnapshot(record);
  }

  getAppSnapshot(client: AuthSession): AppSnapshot {
    return {
      serverInfo: {
        name: "pi-remote",
        version: "0.1.0",
        now: this.now(),
      },
      currentClientAuthInfo: {
        clientId: client.clientId,
        keyId: client.keyId,
        tokenExpiresAt: client.expiresAt,
      },
      sessionSummaries: this.listSessionSummaries(),
      recentNotices: [],
      defaultAttachSessionId: this.sessions.values().next().value?.sessionId,
    };
  }

  listSessionSummaries(): SessionSummary[] {
    return [...this.sessions.values()].map((record) => ({
      sessionId: record.sessionId,
      sessionName: record.sessionName,
      status: record.status,
      draftRevision: record.draft.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastSessionStreamOffset: this.streams.getHeadOffset(sessionEventsStreamId(record.sessionId)),
    }));
  }

  touchPresence(sessionId: string, client: AuthSession, connectionId?: string): void {
    const record = this.getRequired(sessionId);
    const now = this.now();
    this.pruneExpiredPresence(record, now);
    const resolvedConnectionId = connectionId ?? randomUUID();
    const presenceKey = resolvedConnectionId;
    const existing = record.presence.get(presenceKey);
    if (existing) {
      existing.lastSeenAt = now;
      existing.connectionId = resolvedConnectionId;
      existing.lastSeenAppOffset = this.streams.getHeadOffset(appEventsStreamId());
      existing.lastSeenSessionOffset = this.streams.getHeadOffset(sessionEventsStreamId(sessionId));
      return;
    }

    record.presence.set(presenceKey, {
      clientId: client.clientId,
      connectionId: resolvedConnectionId,
      connectedAt: now,
      lastSeenAt: now,
      lastSeenAppOffset: this.streams.getHeadOffset(appEventsStreamId()),
      lastSeenSessionOffset: this.streams.getHeadOffset(sessionEventsStreamId(sessionId)),
    });
  }

  detachPresence(sessionId: string, connectionId: string): void {
    const record = this.getRequired(sessionId);
    record.presence.delete(connectionId);
  }

  async dispose(): Promise<void> {
    for (const record of this.sessions.values()) {
      await record.runtime.dispose();
    }
    this.sessions.clear();
    await this.runtimeFactory.dispose();
  }

  private getRequired(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new RemoteError("Session not found", 404);
    }
    return record;
  }

  private pruneExpiredPresence(record: SessionRecord, now: number): void {
    for (const [presenceKey, presence] of record.presence.entries()) {
      if (now - presence.lastSeenAt > this.presenceTtlMs) {
        record.presence.delete(presenceKey);
      }
    }
  }

  private toSessionSnapshot(record: SessionRecord): SessionSnapshot {
    return {
      sessionId: record.sessionId,
      sessionName: record.sessionName,
      status: record.status,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      activeTools: [...record.activeTools],
      draft: {
        text: record.draft.text,
        attachments: [...record.draft.attachments],
        revision: record.draft.revision,
        updatedAt: record.draft.updatedAt,
        updatedByClientId: record.draft.updatedByClientId,
      },
      draftRevision: record.draft.revision,
      transcript: [...record.transcript],
      queue: {
        depth: record.queue.depth,
        nextSequence: record.queue.nextSequence,
      },
      retry: {
        status: record.retry.status,
      },
      compaction: {
        status: record.compaction.status,
      },
      presence: [...record.presence.values()],
      activeRun: record.activeRun,
      lastSessionStreamOffset: this.streams.getHeadOffset(sessionEventsStreamId(record.sessionId)),
      lastAppStreamOffsetSeenByServer: record.lastAppStreamOffsetSeenByServer,
      streamingState: record.streamingState,
      pendingToolCalls: [...record.pendingToolCalls],
      errorMessage: record.errorMessage,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}
