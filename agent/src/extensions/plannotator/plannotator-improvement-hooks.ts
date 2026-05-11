import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOKS_BASE_DIR = join(homedir(), ".plannotator", "hooks");
const LEGACY_BASE_DIR = join(homedir(), ".plannotator");
const MAX_FILE_SIZE = 50 * 1024;

const KNOWN_HOOKS = {
  "enterplanmode-improve": {
    path: "compound/enterplanmode-improve-hook.txt",
    legacyPath: "compound/enterplanmode-improve-hook.txt",
  },
} as const;

export type ImprovementHookName = keyof typeof KNOWN_HOOKS;

export interface ImprovementHookResult {
  content: string;
  hookName: ImprovementHookName;
  filePath: string;
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function tryReadHookFile(
  filePath: string,
  hookName: ImprovementHookName,
): ImprovementHookResult | null {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) return null;
    const content = readFileSync(filePath, "utf-8").trim();
    if (content.length === 0) return null;
    return { content, hookName, filePath };
  } catch {
    return null;
  }
}

export function readImprovementHook(hookName: ImprovementHookName): ImprovementHookResult | null {
  const entry = KNOWN_HOOKS[hookName];
  const newPath = join(HOOKS_BASE_DIR, entry.path);
  if (fileExists(newPath)) {
    return tryReadHookFile(newPath, hookName);
  }
  const legacyPath = join(LEGACY_BASE_DIR, entry.legacyPath);
  return tryReadHookFile(legacyPath, hookName);
}
