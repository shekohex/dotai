import { access } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createChildSessionFile } from "./persistence.js";

export async function assertLiteSessionPathAccessible(sessionPath: string): Promise<void> {
  await access(sessionPath).catch((error: unknown) => {
    throw new Error(`subagent resume failed: sessionPath is not accessible: ${sessionPath}`, {
      cause: error,
    });
  });
}

export function createLiteSessionManager(options: {
  cwd: string;
  sessionId: string;
  parentSessionPath?: string;
  persisted?: boolean;
}): { sessionManager: SessionManager; sessionPath?: string; persisted: boolean } {
  const persisted =
    options.parentSessionPath !== undefined && options.parentSessionPath.length > 0
      ? (options.persisted ?? true)
      : false;
  const sessionPath = createChildSessionFile({
    cwd: options.cwd,
    sessionId: options.sessionId,
    parentSessionPath: options.parentSessionPath,
    persisted,
  });
  return {
    sessionPath,
    persisted,
    sessionManager:
      sessionPath === undefined
        ? SessionManager.inMemory(options.cwd)
        : SessionManager.open(sessionPath, undefined, options.cwd),
  };
}
