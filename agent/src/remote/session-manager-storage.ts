import type { SessionManager } from "@mariozechner/pi-coding-agent";

const PRE_ASSISTANT_PERSIST_PATCH_FLAG = Symbol("remote.preAssistantPersistPatched");

type SessionManagerWithInternals = SessionManager & {
  [PRE_ASSISTANT_PERSIST_PATCH_FLAG]?: boolean;
};

export function flushPersistedSessionManagerToDisk(sessionManager: SessionManager): void {
  if (!sessionManager.isPersisted()) {
    return;
  }
  if ((sessionManager.getSessionFile()?.length ?? 0) === 0) {
    return;
  }

  const rewrite: unknown = Reflect.get(sessionManager as object, "_rewriteFile");
  if (!isRewriteFunction(rewrite)) {
    return;
  }

  if (!hasAssistantMessage(sessionManager)) {
    rewrite.call(sessionManager);
    setFlushedState(sessionManager, true);
    installPreAssistantPersistPatch(sessionManager, rewrite);
    return;
  }

  rewrite.call(sessionManager);
  setFlushedState(sessionManager, true);
}

function isRewriteFunction(value: unknown): value is () => void {
  return typeof value === "function";
}

function hasAssistantMessage(sessionManager: SessionManager): boolean {
  return sessionManager
    .getEntries()
    .some((entry) => entry.type === "message" && entry.message.role === "assistant");
}

function installPreAssistantPersistPatch(
  sessionManager: SessionManager,
  rewriteFile: () => void,
): void {
  const manager = sessionManager as SessionManagerWithInternals;
  if (manager[PRE_ASSISTANT_PERSIST_PATCH_FLAG] === true) {
    return;
  }

  const persist: unknown = Reflect.get(sessionManager as object, "_persist");
  if (!isPersistFunction(persist)) {
    return;
  }

  manager[PRE_ASSISTANT_PERSIST_PATCH_FLAG] = true;

  Reflect.set(sessionManager as object, "_persist", function patchedPersist(entry: unknown): void {
    if (!hasAssistantMessage(sessionManager)) {
      rewriteFile.call(sessionManager);
      setFlushedState(sessionManager, true);
      return;
    }

    manager[PRE_ASSISTANT_PERSIST_PATCH_FLAG] = false;
    Reflect.set(sessionManager as object, "_persist", persist);
    setFlushedState(sessionManager, true);
    persist.call(sessionManager, entry);
  });
}

function isPersistFunction(value: unknown): value is (entry: unknown) => void {
  return typeof value === "function";
}

function setFlushedState(sessionManager: SessionManager, flushed: boolean): void {
  Reflect.set(sessionManager as object, "flushed", flushed);
}
