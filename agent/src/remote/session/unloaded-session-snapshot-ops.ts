import { RemoteError } from "../errors.js";
import type { AuthSession } from "../auth.js";
import type { SessionCatalog } from "../session-catalog.js";
import type { SessionSnapshot } from "../schemas.js";
import type { SessionRecord } from "./types.js";
import { loadUnloadedSessionSnapshot } from "./unloaded-session-snapshot.js";

export function loadSessionSnapshotRecord(input: {
  sessionId: string;
  client: AuthSession;
  connectionId?: string;
  options?: { entriesLimit?: number; entriesOffset?: number };
  loadedRecord: SessionRecord | undefined;
  catalog: SessionCatalog;
  touchPresence: (sessionId: string, client: AuthSession, connectionId?: string) => void;
  getLoadedSnapshot: (
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
    options?: { entriesLimit?: number; entriesOffset?: number },
  ) => SessionSnapshot;
}): SessionSnapshot {
  if (input.loadedRecord) {
    return input.getLoadedSnapshot(
      input.sessionId,
      input.client,
      input.connectionId,
      input.options,
    );
  }

  const catalogRecord = input.catalog.get(input.sessionId);
  if (!catalogRecord) {
    throw new RemoteError("Session not found", 404);
  }

  input.touchPresence(input.sessionId, input.client, input.connectionId);
  return loadUnloadedSessionSnapshot({
    record: catalogRecord,
    entriesLimit: input.options?.entriesLimit,
    entriesOffset: input.options?.entriesOffset,
  });
}
