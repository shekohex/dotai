import { dirname, join, sep } from "node:path";
import { getAgentRuntime } from "../interview/settings.js";

export const ARCHIVED_DIR_NAME = "archived";

export function getSessionsRoot(): string {
  return join(getAgentRuntime(), "sessions");
}

export function getArchivedDir(sessionDir: string): string {
  return join(sessionDir, ARCHIVED_DIR_NAME);
}

export function usesDefaultLayout(sessionDir: string, root: string): boolean {
  return sessionDir.startsWith(`${root}${sep}`) && dirname(sessionDir) === root;
}
