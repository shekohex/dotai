/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/strict-boolean-expressions, unicorn/prefer-import-meta-properties */
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginDirectory, "..", "..", "..");

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function getFilename(context) {
  const filename = context.filename ?? context.getFilename?.() ?? "<unknown>";
  if (!filename || filename === "<input>" || filename === "<text>" || filename === "<unknown>") {
    return filename;
  }
  if (typeof filename === "string" && filename.startsWith("file://")) {
    return normalizePath(path.resolve(fileURLToPath(filename)));
  }
  return normalizePath(path.resolve(filename));
}

function getRelativeFilename(context) {
  const filename = getFilename(context);
  if (!filename || filename.startsWith("<")) {
    return filename;
  }
  return normalizePath(path.relative(repoRoot, filename));
}

function normalizeAllowlist(files) {
  if (!Array.isArray(files)) {
    return [];
  }
  return files
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => normalizePath(value));
}

function isAllowlistedFile(context, allowlist) {
  const relativeFilename = getRelativeFilename(context);
  const absoluteFilename = getFilename(context);
  return allowlist.some(
    (entry) =>
      entry === relativeFilename ||
      entry === absoluteFilename ||
      (typeof relativeFilename === "string" && relativeFilename.endsWith(`/${entry}`)) ||
      (typeof absoluteFilename === "string" && absoluteFilename.endsWith(`/${entry}`)),
  );
}

export {
  getFilename,
  getRelativeFilename,
  isAllowlistedFile,
  normalizeAllowlist,
  normalizePath,
  repoRoot,
};
