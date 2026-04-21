import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { FileEntry, GitStatusEntry } from "./model.js";
import { loadGitFileMetadata } from "./entry-git.js";
import { collectRecentFileReferences } from "./references.js";
import { collectSessionFileChanges } from "./session-changes.js";
import { formatDisplayPath, isPathInsideRepo, toCanonicalPath } from "./path-utils.js";

function createFileEntryUpserter(fileMap: Map<string, FileEntry>, cwd: string) {
  return (data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean }): void => {
    const existing = fileMap.get(data.canonicalPath);
    const displayPath = data.displayPath ?? formatDisplayPath(data.canonicalPath, cwd);
    if (existing) {
      fileMap.set(data.canonicalPath, {
        ...existing,
        ...data,
        displayPath,
        exists: data.exists ?? existing.exists,
        isDirectory: data.isDirectory ?? existing.isDirectory,
        isReferenced: existing.isReferenced || data.isReferenced === true,
        inRepo: existing.inRepo || data.inRepo === true,
        isTracked: existing.isTracked || data.isTracked === true,
        hasSessionChange: existing.hasSessionChange || data.hasSessionChange === true,
        lastTimestamp: Math.max(existing.lastTimestamp, data.lastTimestamp ?? 0),
      });
      return;
    }

    fileMap.set(data.canonicalPath, {
      canonicalPath: data.canonicalPath,
      resolvedPath: data.resolvedPath ?? data.canonicalPath,
      displayPath,
      exists: data.exists ?? true,
      isDirectory: data.isDirectory,
      status: data.status,
      inRepo: data.inRepo ?? false,
      isTracked: data.isTracked ?? false,
      isReferenced: data.isReferenced ?? false,
      hasSessionChange: data.hasSessionChange ?? false,
      lastTimestamp: data.lastTimestamp ?? 0,
    });
  };
}

function upsertGitFiles(
  gitFiles: Array<{ canonicalPath: string; isDirectory: boolean }>,
  statusMap: Map<string, GitStatusEntry>,
  trackedSet: Set<string>,
  upsertFile: (data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean }) => void,
): void {
  for (const file of gitFiles) {
    upsertFile({
      canonicalPath: file.canonicalPath,
      resolvedPath: file.canonicalPath,
      isDirectory: file.isDirectory,
      exists: true,
      status: statusMap.get(file.canonicalPath)?.status,
      inRepo: true,
      isTracked: trackedSet.has(file.canonicalPath),
    });
  }
}

function upsertStatusOnlyFiles(
  gitRoot: string | null,
  statusMap: Map<string, GitStatusEntry>,
  trackedSet: Set<string>,
  fileMap: Map<string, FileEntry>,
  upsertFile: (data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean }) => void,
): void {
  for (const [canonicalPath, statusEntry] of statusMap.entries()) {
    if (fileMap.has(canonicalPath)) {
      continue;
    }

    upsertFile({
      canonicalPath,
      resolvedPath: canonicalPath,
      isDirectory: statusEntry.isDirectory,
      exists: statusEntry.exists,
      status: statusEntry.status,
      inRepo: isPathInsideRepo(gitRoot, canonicalPath),
      isTracked: trackedSet.has(canonicalPath) || statusEntry.status !== "??",
    });
  }
}

function upsertReferencedFiles(
  entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
  cwd: string,
  gitRoot: string | null,
  statusMap: Map<string, GitStatusEntry>,
  trackedSet: Set<string>,
  upsertFile: (data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean }) => void,
): void {
  const references = collectRecentFileReferences(entries, cwd, 200).filter((ref) => ref.exists);
  for (const ref of references) {
    const canonical = toCanonicalPath(ref.path);
    if (!canonical) {
      continue;
    }

    upsertFile({
      canonicalPath: canonical.canonicalPath,
      resolvedPath: canonical.canonicalPath,
      isDirectory: canonical.isDirectory,
      exists: true,
      status: statusMap.get(canonical.canonicalPath)?.status,
      inRepo: isPathInsideRepo(gitRoot, canonical.canonicalPath),
      isTracked: trackedSet.has(canonical.canonicalPath),
      isReferenced: true,
    });
  }
}

function upsertSessionChangedFiles(
  sessionChanges: Map<string, { lastTimestamp: number }>,
  gitRoot: string | null,
  statusMap: Map<string, GitStatusEntry>,
  trackedSet: Set<string>,
  upsertFile: (data: Partial<FileEntry> & { canonicalPath: string; isDirectory: boolean }) => void,
): void {
  for (const [canonicalPath, change] of sessionChanges.entries()) {
    const canonical = toCanonicalPath(canonicalPath);
    if (!canonical) {
      continue;
    }

    upsertFile({
      canonicalPath: canonical.canonicalPath,
      resolvedPath: canonical.canonicalPath,
      isDirectory: canonical.isDirectory,
      exists: true,
      status: statusMap.get(canonical.canonicalPath)?.status,
      inRepo: isPathInsideRepo(gitRoot, canonical.canonicalPath),
      isTracked: trackedSet.has(canonical.canonicalPath),
      hasSessionChange: true,
      lastTimestamp: change.lastTimestamp,
    });
  }
}

function sortFileEntries(fileMap: Map<string, FileEntry>): FileEntry[] {
  return Array.from(fileMap.values()).toSorted((a, b) => {
    const aDirty = Boolean(a.status);
    const bDirty = Boolean(b.status);
    if (aDirty !== bDirty) {
      return aDirty ? -1 : 1;
    }
    if (a.inRepo !== b.inRepo) {
      return a.inRepo ? -1 : 1;
    }
    if (a.hasSessionChange !== b.hasSessionChange) {
      return a.hasSessionChange ? -1 : 1;
    }
    if (a.lastTimestamp !== b.lastTimestamp) {
      return b.lastTimestamp - a.lastTimestamp;
    }
    if (a.isReferenced !== b.isReferenced) {
      return a.isReferenced ? -1 : 1;
    }
    return a.displayPath.localeCompare(b.displayPath);
  });
}

export const buildFileEntries = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<{ files: FileEntry[]; gitRoot: string | null }> => {
  const entries = ctx.sessionManager.getBranch();
  const sessionChanges = collectSessionFileChanges(entries, ctx.cwd);
  const { gitRoot, statusMap, trackedSet, gitFiles } = await loadGitFileMetadata(pi, ctx.cwd);
  const fileMap = new Map<string, FileEntry>();
  const upsertFile = createFileEntryUpserter(fileMap, ctx.cwd);

  upsertGitFiles(gitFiles, statusMap, trackedSet, upsertFile);
  upsertStatusOnlyFiles(gitRoot, statusMap, trackedSet, fileMap, upsertFile);
  upsertReferencedFiles(entries, ctx.cwd, gitRoot, statusMap, trackedSet, upsertFile);
  upsertSessionChangedFiles(sessionChanges, gitRoot, statusMap, trackedSet, upsertFile);

  return { files: sortFileEntries(fileMap), gitRoot };
};
