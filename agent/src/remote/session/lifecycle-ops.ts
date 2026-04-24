import type { SessionRecord } from "./types.js";

export async function disposeSessionRecord(record: SessionRecord): Promise<void> {
  for (const [requestId, pending] of record.pendingUiRequests) {
    record.pendingUiRequests.delete(requestId);
    pending.resolve({ id: requestId, cancelled: true });
  }
  record.runtimeSubscription?.();
  await record.runtime.dispose();
}

export async function disposeSessionRegistry(input: {
  sessions: Map<string, SessionRecord>;
  disposeRuntimeFactory: () => Promise<void>;
}): Promise<void> {
  for (const record of input.sessions.values()) {
    await disposeSessionRecord(record);
  }
  input.sessions.clear();
  await input.disposeRuntimeFactory();
}
