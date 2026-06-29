import { mkdir, readdir, rename, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { getArchivedDir, usesDefaultLayout } from "./paths.js";

export interface SweepOptions {
  sessionDir: string;
  root: string;
  maxAgeDays: number;
  activeFile: string | undefined;
  now: number;
}

const DAY_MS = 86_400_000;

async function sweepDir(
  dir: string,
  cutoff: number,
  activeFile: string | undefined,
): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let archived = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = join(dir, entry.name);
    if (filePath === activeFile) continue;

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      continue;
    }

    if (mtimeMs >= cutoff) continue;

    const archivedDir = getArchivedDir(dir);
    try {
      await mkdir(archivedDir, { recursive: true });
      await rename(filePath, join(archivedDir, entry.name));
      archived += 1;
    } catch {
      // Rename failed (e.g. collision, vanished, cross-device). Skip silently.
    }
  }
  return archived;
}

export async function sweepSessions(options: SweepOptions): Promise<number> {
  const cutoff = options.now - options.maxAgeDays * DAY_MS;

  let scanDirs: string[];
  if (usesDefaultLayout(options.sessionDir, options.root)) {
    let rootEntries: Dirent[];
    try {
      rootEntries = await readdir(options.root, { withFileTypes: true });
    } catch {
      return 0;
    }
    scanDirs = rootEntries.filter((e) => e.isDirectory()).map((e) => join(options.root, e.name));
  } else {
    scanDirs = [options.sessionDir];
  }

  let total = 0;
  for (const dir of scanDirs) {
    total += await sweepDir(dir, cutoff, options.activeFile);
  }
  return total;
}
