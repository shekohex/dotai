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
  readConnectionCapabilities: (
    clientId: string,
    connectionId: string,
  ) => ClientCapabilities | undefined;
  getLastAppOffset: () => string;
  getLastSessionOffset: (sessionId: string) => string;
}): void {
  input.pruneExpiredPresence(input.record, input.now);
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
