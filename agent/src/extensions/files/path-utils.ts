import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const formatDisplayPath = (absolutePath: string, cwd: string): string => {
  const normalizedCwd = path.resolve(cwd);
  if (absolutePath.startsWith(normalizedCwd + path.sep)) {
    return path.relative(normalizedCwd, absolutePath);
  }

  return absolutePath;
};

export const toCanonicalPath = (
  inputPath: string,
): { canonicalPath: string; isDirectory: boolean } | null => {
  if (!existsSync(inputPath)) {
    return null;
  }

  try {
    const canonicalPath = realpathSync(inputPath);
    const stats = statSync(canonicalPath);
    return { canonicalPath, isDirectory: stats.isDirectory() };
  } catch {
    return null;
  }
};

export const toCanonicalPathMaybeMissing = (
  inputPath: string,
): { canonicalPath: string; isDirectory: boolean; exists: boolean } | null => {
  const resolvedPath = path.resolve(inputPath);
  if (!existsSync(resolvedPath)) {
    return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: false };
  }

  try {
    const canonicalPath = realpathSync(resolvedPath);
    const stats = statSync(canonicalPath);
    return { canonicalPath, isDirectory: stats.isDirectory(), exists: true };
  } catch {
    return { canonicalPath: path.normalize(resolvedPath), isDirectory: false, exists: true };
  }
};

export function isPathInsideRepo(gitRoot: string | null, canonicalPath: string): boolean {
  if (gitRoot === null) {
    return false;
  }

  const relative = path.relative(gitRoot, canonicalPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
