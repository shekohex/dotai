import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { GitStatusEntry } from "./model.js";
import { toCanonicalPath, toCanonicalPathMaybeMissing } from "./path-utils.js";

const splitNullSeparated = (value: string): string[] => value.split("\0").filter(Boolean);

const getGitRoot = async (pi: ExtensionAPI, cwd: string): Promise<string | null> => {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    return null;
  }

  const root = result.stdout.trim();
  return root ? root : null;
};

const getGitStatusMap = async (
  pi: ExtensionAPI,
  cwd: string,
): Promise<Map<string, GitStatusEntry>> => {
  const statusMap = new Map<string, GitStatusEntry>();
  const statusResult = await pi.exec("git", ["status", "--porcelain=1", "-z"], { cwd });
  if (statusResult.code !== 0 || !statusResult.stdout) {
    return statusMap;
  }

  const entries = splitNullSeparated(statusResult.stdout);

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const statusLabel = status.replaceAll(/\s/g, "") || status.trim();
    let filePath = entry.slice(3);
    if ((status.startsWith("R") || status.startsWith("C")) && entries[i + 1]) {
      filePath = entries[i + 1];
      i += 1;
    }
    if (!filePath) continue;

    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const canonical = toCanonicalPathMaybeMissing(resolved);
    if (!canonical) continue;
    statusMap.set(canonical.canonicalPath, {
      status: statusLabel,
      exists: canonical.exists,
      isDirectory: canonical.isDirectory,
    });
  }

  return statusMap;
};

const getGitFiles = async (
  pi: ExtensionAPI,
  gitRoot: string,
): Promise<{
  tracked: Set<string>;
  files: Array<{ canonicalPath: string; isDirectory: boolean }>;
}> => {
  const tracked = new Set<string>();
  const files: Array<{ canonicalPath: string; isDirectory: boolean }> = [];

  const trackedResult = await pi.exec("git", ["ls-files", "-z"], { cwd: gitRoot });
  if (trackedResult.code === 0 && trackedResult.stdout) {
    for (const relativePath of splitNullSeparated(trackedResult.stdout)) {
      const resolvedPath = path.resolve(gitRoot, relativePath);
      const canonical = toCanonicalPath(resolvedPath);
      if (!canonical) continue;
      tracked.add(canonical.canonicalPath);
      files.push(canonical);
    }
  }

  const untrackedResult = await pi.exec(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard"],
    { cwd: gitRoot },
  );
  if (untrackedResult.code === 0 && untrackedResult.stdout) {
    for (const relativePath of splitNullSeparated(untrackedResult.stdout)) {
      const resolvedPath = path.resolve(gitRoot, relativePath);
      const canonical = toCanonicalPath(resolvedPath);
      if (!canonical) continue;
      files.push(canonical);
    }
  }

  return { tracked, files };
};

export async function loadGitFileMetadata(
  pi: ExtensionAPI,
  cwd: string,
): Promise<{
  gitRoot: string | null;
  statusMap: Map<string, GitStatusEntry>;
  trackedSet: Set<string>;
  gitFiles: Array<{ canonicalPath: string; isDirectory: boolean }>;
}> {
  const gitRoot = await getGitRoot(pi, cwd);
  if (gitRoot === null) {
    return { gitRoot, statusMap: new Map(), trackedSet: new Set(), gitFiles: [] };
  }

  const [statusMap, gitListing] = await Promise.all([
    getGitStatusMap(pi, gitRoot),
    getGitFiles(pi, gitRoot),
  ]);
  return {
    gitRoot,
    statusMap,
    trackedSet: gitListing.tracked,
    gitFiles: gitListing.files,
  };
}
