import type { ModesFile } from "../../mode-utils.js";

const remoteModesBySessionId = new Map<string, ModesFile>();

export function setRemoteModesSnapshot(sessionId: string, modes: ModesFile | undefined): void {
  if (modes === undefined) {
    remoteModesBySessionId.delete(sessionId);
    return;
  }

  remoteModesBySessionId.set(sessionId, structuredClone(modes));
}

export function getRemoteModesSnapshot(sessionId: string): ModesFile | undefined {
  const modes = remoteModesBySessionId.get(sessionId);
  return modes === undefined ? undefined : structuredClone(modes);
}

export function clearRemoteModesSnapshot(sessionId: string): void {
  remoteModesBySessionId.delete(sessionId);
}
