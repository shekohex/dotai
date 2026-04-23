import type { SessionManager } from "@mariozechner/pi-coding-agent";

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

  rewrite.call(sessionManager);
}

function isRewriteFunction(value: unknown): value is () => void {
  return typeof value === "function";
}
