import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const PROJECT_INSTRUCTIONS_FILE = "CONDUCTOR.md";
const MAX_CHARS = 32_000;

export interface ProjectInstructions {
  path: string;
  content: string;
}

/** Reads the first CONDUCTOR.md found in `directories`, in order. The file is optional. */
export async function readProjectInstructions(
  directories: readonly string[],
): Promise<ProjectInstructions | null> {
  for (const directory of new Set(directories)) {
    const filePath = path.join(directory, PROJECT_INSTRUCTIONS_FILE);
    const content = await readFile(filePath, "utf8").catch(() => null);
    if (content === null || !content.trim()) continue;
    const trimmed = content.trim();
    return {
      path: filePath,
      content:
        trimmed.length > MAX_CHARS
          ? `${trimmed.slice(0, MAX_CHARS)}\n\n[truncated; read ${filePath} for the rest]`
          : trimmed,
    };
  }
  return null;
}

/**
 * Where the UI edits CONDUCTOR.md: an existing file in `directories` order, otherwise the last
 * directory (the project root), so a new file lands next to AGENTS.md.
 */
export async function projectInstructionsPath(
  directories: readonly string[],
): Promise<string | null> {
  for (const directory of directories) {
    const filePath = path.join(directory, PROJECT_INSTRUCTIONS_FILE);
    if (await stat(filePath).catch(() => null)) return filePath;
  }
  const fallback = directories.at(-1);
  return fallback ? path.join(fallback, PROJECT_INSTRUCTIONS_FILE) : null;
}
