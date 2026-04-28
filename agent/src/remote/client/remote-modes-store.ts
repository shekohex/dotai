import type { ModesFile } from "../../mode-utils.js";

type SessionManagerLike = object;

const remoteModesBySessionManager = new WeakMap<SessionManagerLike, ModesFile>();

export function setRemoteModesSnapshot(
  sessionManager: SessionManagerLike,
  modes: ModesFile | undefined,
): void {
  if (modes === undefined) {
    remoteModesBySessionManager.delete(sessionManager);
    return;
  }

  remoteModesBySessionManager.set(sessionManager, structuredClone(modes));
}

export function getRemoteModesSnapshot(sessionManager: SessionManagerLike): ModesFile | undefined {
  const modes = remoteModesBySessionManager.get(sessionManager);
  return modes === undefined ? undefined : structuredClone(modes);
}

export function clearRemoteModesSnapshot(sessionManager: SessionManagerLike): void {
  remoteModesBySessionManager.delete(sessionManager);
}
