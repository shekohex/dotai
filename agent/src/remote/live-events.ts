import type { SessionSyncEvent } from "./schemas.js";

type SessionSyncEventListener = (event: Extract<SessionSyncEvent, { type: "patch" }>) => void;

export class SessionLiveEventBus {
  private readonly sessionSyncListenersBySessionId = new Map<
    string,
    Set<SessionSyncEventListener>
  >();

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
