import { randomUUID } from "node:crypto";
import type { AuthSession } from "../auth.js";
import type { ClientCapabilities } from "../schemas.js";
import type { SessionCatalog } from "../session-catalog.js";
import { ensurePresenceSessionExists } from "./presence-session.js";
import { detachSessionPresence, touchSessionPresence, type SessionRecord } from "./deps.js";

export function touchRegistryPresence(input: {
  loadedRecord: SessionRecord | undefined;
  sessionId: string;
  client: AuthSession;
  connectionId?: string;
  catalog: SessionCatalog;
  now: number;
  pruneExpiredPresence: (record: SessionRecord, now: number) => void;
  scheduleEphemeralSessionCleanup: (sessionId: string) => void;
  readConnectionCapabilities: (
    clientId: string,
    connectionId: string,
  ) => ClientCapabilities | undefined;
}): void {
  if (input.loadedRecord === undefined) {
    ensurePresenceSessionExists(input.catalog, input.sessionId);
    return;
  }
  touchSessionPresence({
    record: input.loadedRecord,
    client: input.client,
    connectionId: input.connectionId,
    now: input.now,
    createConnectionId: () => randomUUID(),
    pruneExpiredPresence: input.pruneExpiredPresence,
    onPresencePrunedToZero: (record) => {
      if (record.persistence === "ephemeral")
        input.scheduleEphemeralSessionCleanup(record.sessionId);
    },
    readConnectionCapabilities: input.readConnectionCapabilities,
  });
}

export function detachRegistryPresence(input: {
  loadedRecord: SessionRecord | undefined;
  sessionId: string;
  connectionId: string;
  catalog: SessionCatalog;
  scheduleEphemeralSessionCleanup: (sessionId: string) => void;
}): void {
  if (input.loadedRecord === undefined) {
    ensurePresenceSessionExists(input.catalog, input.sessionId);
    return;
  }
  detachSessionPresence(input.loadedRecord, input.connectionId);
  if (input.loadedRecord.persistence === "ephemeral" && input.loadedRecord.presence.size === 0) {
    input.scheduleEphemeralSessionCleanup(input.sessionId);
  }
}
