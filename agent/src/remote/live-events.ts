import type { SessionSyncEvent, StreamEventEnvelope } from "./schemas.js";

type LiveEventListener = (event: StreamEventEnvelope) => void;
type SessionSyncEventListener = (event: Extract<SessionSyncEvent, { type: "patch" }>) => void;

export class SessionLiveEventBus {
  private readonly listenersByStreamId = new Map<string, Set<LiveEventListener>>();
  private readonly sessionSyncListenersBySessionId = new Map<
    string,
    Set<SessionSyncEventListener>
  >();

  publish(streamId: string, event: StreamEventEnvelope): void {
    const listeners = this.listenersByStreamId.get(streamId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  subscribe(streamId: string, listener: LiveEventListener): () => void {
    const existing = this.listenersByStreamId.get(streamId);
    if (existing) {
      existing.add(listener);
      return () => {
        existing.delete(listener);
      };
    }

    const created = new Set<LiveEventListener>([listener]);
    this.listenersByStreamId.set(streamId, created);
    return () => {
      created.delete(listener);
      if (created.size === 0) {
        this.listenersByStreamId.delete(streamId);
      }
    };
  }

  publishSessionSyncEvent(
    sessionId: string,
    event: Extract<SessionSyncEvent, { type: "patch" }>,
  ): void {
    const listeners = this.sessionSyncListenersBySessionId.get(sessionId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  subscribeSessionSyncEvent(sessionId: string, listener: SessionSyncEventListener): () => void {
    const existing = this.sessionSyncListenersBySessionId.get(sessionId);
    if (existing) {
      existing.add(listener);
      return () => {
        existing.delete(listener);
      };
    }

    const created = new Set<SessionSyncEventListener>([listener]);
    this.sessionSyncListenersBySessionId.set(sessionId, created);
    return () => {
      created.delete(listener);
      if (created.size === 0) {
        this.sessionSyncListenersBySessionId.delete(sessionId);
      }
    };
  }
}
