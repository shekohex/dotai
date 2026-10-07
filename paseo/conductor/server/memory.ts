import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConductorPaths } from "./paths.js";

export const CONDUCTOR_CORE_FILES = {
  "instructions.md":
    "# Instructions\n\nStanding instructions for this conductor. User-owned.\n",
  "decisions.md": "# Decisions\n\n",
  "notes.md": "# Notes\n\nActive work, worker ids, open threads.\n",
} as const;

export const GLOBAL_CORE_FILES = {
  "MEMORY.md": "# Memory\n\nOne line per entry, shared by all conductors.\n",
} as const;

export interface MemoryFile {
  name: string;
  path: string;
  content: string;
  core: boolean;
}

async function writeIfAbsent(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { flag: "wx" }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return;
    throw error;
  });
}

async function seed(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeIfAbsent(path.join(directory, name), content);
  }
}

export async function ensureConductorMemory(
  paths: ConductorPaths,
  conductorId: string,
): Promise<void> {
  await seed(paths.conductorDir(conductorId), CONDUCTOR_CORE_FILES);
  await seed(paths.sharedMemoryDir, GLOBAL_CORE_FILES);
}

/** Lists Markdown files in `directory`, core files first in their declared order. */
export async function listMemoryFiles(
  directory: string,
  coreFiles: Record<string, string>,
): Promise<MemoryFile[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const coreNames = Object.keys(coreFiles);
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const rank = (name: string) =>
        coreNames.includes(name) ? coreNames.indexOf(name) : coreNames.length;
      return rank(left) - rank(right) || left.localeCompare(right);
    });
  const files: MemoryFile[] = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    const content = await readFile(filePath, "utf8").catch(() => null);
    if (content !== null) {
      files.push({
        name,
        path: filePath,
        content,
        core: coreNames.includes(name),
      });
    }
  }
  return files;
}
