import type { StreamEventEnvelope } from "./schemas.js";

type LiveEventListener = (event: StreamEventEnvelope) => void;

export class SessionLiveEventBus {
  private readonly listenersByStreamId = new Map<string, Set<LiveEventListener>>();

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
}
