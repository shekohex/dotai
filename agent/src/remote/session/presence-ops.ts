import type { AuthSession } from "../auth.js";
import { cloneClientCapabilities } from "../capabilities.js";
import type { ClientCapabilities } from "../schemas.js";
import type { SessionRecord } from "./types.js";

export function touchSessionPresence(input: {
  record: SessionRecord;
  client: AuthSession;
  connectionId?: string;
  now: number;
  createConnectionId: () => string;
  pruneExpiredPresence: (record: SessionRecord, now: number) => void;
  onPresencePrunedToZero?: (record: SessionRecord) => void;
  readConnectionCapabilities: (
    clientId: string,
    connectionId: string,
  ) => ClientCapabilities | undefined;
  getLastAppOffset: () => string;
  getLastSessionOffset: (sessionId: string) => string;
}): void {
  const previousPresenceCount = input.record.presence.size;
  input.pruneExpiredPresence(input.record, input.now);
  if (previousPresenceCount > 0 && input.record.presence.size === 0) {
    input.onPresencePrunedToZero?.(input.record);
  }
  const resolvedConnectionId = input.connectionId ?? input.createConnectionId();
  const capabilities = input.readConnectionCapabilities(
    input.client.clientId,
    resolvedConnectionId,
  );
  const existing = input.record.presence.get(resolvedConnectionId);
  if (existing) {
    existing.lastSeenAt = input.now;
    existing.connectionId = resolvedConnectionId;
    existing.clientCapabilities = capabilities ? cloneClientCapabilities(capabilities) : undefined;
    existing.lastSeenAppOffset = input.getLastAppOffset();
    existing.lastSeenSessionOffset = input.getLastSessionOffset(input.record.sessionId);
    return;
  }

  input.record.presence.set(resolvedConnectionId, {
    clientId: input.client.clientId,
    connectionId: resolvedConnectionId,
    connectedAt: input.now,
    lastSeenAt: input.now,
    ...(capabilities ? { clientCapabilities: cloneClientCapabilities(capabilities) } : {}),
    lastSeenAppOffset: input.getLastAppOffset(),
    lastSeenSessionOffset: input.getLastSessionOffset(input.record.sessionId),
  });
}

export function detachSessionPresence(record: SessionRecord, connectionId: string): void {
  record.presence.delete(connectionId);
}
