import type { SessionRecord } from "./session/types.js";

export class LoadedRuntimeRegistry {
  private readonly recordsBySessionId = new Map<string, SessionRecord>();
  private readonly pendingLoads = new Map<string, Promise<SessionRecord>>();

  get(sessionId: string): SessionRecord | undefined {
    return this.recordsBySessionId.get(sessionId);
  }

  set(record: SessionRecord): void {
    this.recordsBySessionId.set(record.sessionId, record);
  }

  delete(sessionId: string): void {
    this.recordsBySessionId.delete(sessionId);
  }

  values(): IterableIterator<SessionRecord> {
    return this.recordsBySessionId.values();
  }

  entries(): IterableIterator<[string, SessionRecord]> {
    return this.recordsBySessionId.entries();
  }

  asMap(): Map<string, SessionRecord> {
    return this.recordsBySessionId;
  }

  clear(): void {
    this.recordsBySessionId.clear();
  }

  load(sessionId: string, operation: () => Promise<SessionRecord>): Promise<SessionRecord> {
    const existing = this.recordsBySessionId.get(sessionId);
    if (existing) {
      return Promise.resolve(existing);
    }

    const pending = this.pendingLoads.get(sessionId);
    if (pending) {
      return pending;
    }

    const created = operation().finally(() => {
      this.pendingLoads.delete(sessionId);
    });
    this.pendingLoads.set(sessionId, created);
    return created;
  }
}
