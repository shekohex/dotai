import type { SessionSyncEvent } from "./schemas.js";

export function compareSessionVersions(left: string, right: string): number {
  const leftVersion = BigInt(left);
  const rightVersion = BigInt(right);
  if (leftVersion < rightVersion) {
    return -1;
  }
  if (leftVersion > rightVersion) {
    return 1;
  }
  return 0;
}

export function readPatchFingerprint(event: SessionSyncEvent): string | undefined {
  if (event.type !== "patch") {
    return undefined;
  }

  return `${event.version}:${JSON.stringify(event.patch)}`;
}
