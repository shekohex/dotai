import { RemoteError } from "../errors.js";
import { sessionEventsStreamId, type InMemoryDurableStreamStore } from "../streams.js";
import type { SessionCatalog } from "../session-catalog.js";

export function ensurePresenceSessionExists(
  catalog: SessionCatalog,
  streams: InMemoryDurableStreamStore,
  sessionId: string,
): void {
  if (catalog.get(sessionId) === undefined) throw new RemoteError("Session not found", 404);
  streams.ensureStream(sessionEventsStreamId(sessionId));
}
