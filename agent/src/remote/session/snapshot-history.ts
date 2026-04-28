import type { SessionSnapshot } from "../schemas.js";

export function omitSessionSnapshotHistory(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    entries: [],
    transcript: [],
  };
}
