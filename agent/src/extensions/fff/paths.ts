import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME_DIR = path.resolve(os.homedir());

export function isHomeDir(directory: string): boolean {
  return path.resolve(directory) === HOME_DIR;
}

export function isOutsideWorkspaceRelativePath(relativePath: string): boolean {
  return (
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  );
}

export function resolveAuxRoot(absPath: string): { root: string; suffix: string } | null {
  const normalized = path.normalize(absPath.trim()).replace(/\/+$/, "") || path.sep;
  if (!path.isAbsolute(normalized)) return null;
  if (normalized === path.sep) return { root: path.sep, suffix: "" };

  const parts = normalized.split(path.sep);
  const firstGlob = parts.findIndex((part) => /[*?[{]/.test(part));
  const boundary = firstGlob === -1 ? parts.length : firstGlob;

  for (let index = boundary; index > 0; index--) {
    const candidate = parts.slice(0, index).join(path.sep) || path.sep;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(candidate);
    } catch {
      continue;
    }

    if (stats.isFile()) {
      return {
        root: parts.slice(0, index - 1).join(path.sep) || path.sep,
        suffix: parts.slice(index - 1).join("/"),
      };
    }

    return { root: candidate, suffix: parts.slice(index).join("/") };
  }

  return null;
}

export function rootCovers(root: string, target: string): boolean {
  if (root === target) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix);
}
