import { RemoteError } from "../errors.js";
import type { SessionCatalog } from "../session-catalog.js";

export function ensurePresenceSessionExists(catalog: SessionCatalog, sessionId: string): void {
  if (catalog.get(sessionId) === undefined) throw new RemoteError("Session not found", 404);
}
