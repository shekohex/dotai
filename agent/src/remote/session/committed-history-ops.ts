import { RemoteError } from "../errors.js";
import type { AuthSession } from "../auth.js";
import type { SessionCatalog } from "../session-catalog.js";
import {
  loadCommittedSessionHistoryFromFile,
  readCommittedSessionHistory,
  type CommittedSessionHistory,
} from "./committed-history.js";
import type { SessionRecord } from "./types.js";

export function getCommittedSessionHistory(input: {
  sessionId: string;
  client: AuthSession;
  connectionId?: string;
  options?: { entriesLimit?: number; entriesOffset?: number };
  catalog: SessionCatalog;
  loadedRecord: SessionRecord | undefined;
  touchPresence: (sessionId: string, client: AuthSession, connectionId?: string) => void;
}): CommittedSessionHistory {
  if (input.loadedRecord) {
    input.touchPresence(input.sessionId, input.client, input.connectionId);
    const sessionEntries = input.loadedRecord.runtime.session?.sessionManager.getEntries() ?? [];
    return readCommittedSessionHistory({
      entries: sessionEntries,
      entriesLimit: input.options?.entriesLimit,
      entriesOffset: input.options?.entriesOffset,
    });
  }

  const sessionPath = input.catalog.getSessionPath(input.sessionId);
  if (sessionPath === undefined) {
    throw new RemoteError("Session not found", 404);
  }

  return loadCommittedSessionHistoryFromFile({
    sessionPath,
    entriesLimit: input.options?.entriesLimit,
    entriesOffset: input.options?.entriesOffset,
  });
}

export type { CommittedSessionHistory } from "./committed-history.js";
