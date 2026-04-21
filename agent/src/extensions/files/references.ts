import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { FileReference } from "./model.js";
import { formatDisplayPath } from "./path-utils.js";

type ContentBlock = {
  type?: string;
  text?: string;
  arguments?: Record<string, unknown>;
};

const FILE_TAG_REGEX = /<file\s+name=["']([^"']+)["']>/g;
const FILE_URL_REGEX = /file:\/\/[^\s"'<>]+/g;
const PATH_REGEX = /(?:^|[\s"'`([{<])((?:~|\/)[^\s"'`<>)}\]]+)/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const extractFileReferencesFromText = (text: string): string[] => {
  const refs: string[] = [];

  for (const match of text.matchAll(FILE_TAG_REGEX)) {
    refs.push(match[1]);
  }

  for (const match of text.matchAll(FILE_URL_REGEX)) {
    refs.push(match[0]);
  }

  for (const match of text.matchAll(PATH_REGEX)) {
    refs.push(match[1]);
  }

  return refs;
};

const extractPathsFromToolArgs = (args: unknown): string[] => {
  if (typeof args !== "object" || args === null) {
    return [];
  }

  const refs: string[] = [];
  if (!isRecord(args)) {
    return refs;
  }

  const record = args;
  const directKeys = ["path", "file", "filePath", "filepath", "fileName", "filename"] as const;
  const listKeys = ["paths", "files", "filePaths"] as const;

  for (const key of directKeys) {
    const value = record[key];
    if (typeof value === "string") {
      refs.push(value);
    }
  }

  for (const key of listKeys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          refs.push(item);
        }
      }
    }
  }

  return refs;
};

const extractFileReferencesFromContent = (content: unknown): string[] => {
  if (typeof content === "string") {
    return extractFileReferencesFromText(content);
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const refs: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }

    const block: ContentBlock = part;

    if (block.type === "text" && typeof block.text === "string") {
      refs.push(...extractFileReferencesFromText(block.text));
    }

    if (block.type === "toolCall") {
      refs.push(...extractPathsFromToolArgs(block.arguments));
    }
  }

  return refs;
};

const extractFileReferencesFromEntry = (entry: SessionEntry): string[] => {
  if (entry.type === "message") {
    return extractFileReferencesFromContent(entry.message);
  }

  if (entry.type === "custom_message") {
    return extractFileReferencesFromContent(entry.content);
  }

  return [];
};

const sanitizeReference = (raw: string): string => {
  let value = raw.trim();
  value = value.replace(/^["'`(<[]+/, "");
  value = value.replace(/[>"'`,;).\]]+$/, "");
  value = value.replace(/[.,;:]+$/, "");
  return value;
};

const isCommentLikeReference = (value: string): boolean => value.startsWith("//");

const stripLineSuffix = (value: string): string => {
  let result = value.replace(/#L\d+(C\d+)?$/i, "");
  const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
  const segmentStart = lastSeparator >= 0 ? lastSeparator + 1 : 0;
  const segment = result.slice(segmentStart);
  const colonIndex = segment.indexOf(":");
  if (colonIndex >= 0 && /\d/.test(segment[colonIndex + 1] ?? "")) {
    result = result.slice(0, segmentStart + colonIndex);
    return result;
  }

  const lastColon = result.lastIndexOf(":");
  if (lastColon > lastSeparator) {
    const suffix = result.slice(lastColon + 1);
    if (/^\d+(?::\d+)?$/.test(suffix)) {
      result = result.slice(0, lastColon);
    }
  }
  return result;
};

const normalizeReferencePath = (raw: string, cwd: string): string | null => {
  let candidate = sanitizeReference(raw);
  if (!candidate || isCommentLikeReference(candidate)) {
    return null;
  }

  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return null;
    }
  }

  candidate = stripLineSuffix(candidate);
  if (!candidate || isCommentLikeReference(candidate)) {
    return null;
  }

  if (candidate.startsWith("~")) {
    candidate = path.join(os.homedir(), candidate.slice(1));
  }

  if (!path.isAbsolute(candidate)) {
    candidate = path.resolve(cwd, candidate);
  }

  candidate = path.normalize(candidate);
  const root = path.parse(candidate).root;
  if (candidate.length > root.length) {
    candidate = candidate.replace(/[\\/]+$/, "");
  }

  return candidate;
};

export const collectRecentFileReferences = (
  entries: SessionEntry[],
  cwd: string,
  limit: number,
): FileReference[] => {
  const results: FileReference[] = [];
  const seen = new Set<string>();

  for (let i = entries.length - 1; i >= 0 && results.length < limit; i -= 1) {
    const refs = extractFileReferencesFromEntry(entries[i]);
    for (let j = refs.length - 1; j >= 0 && results.length < limit; j -= 1) {
      const normalized = normalizeReferencePath(refs[j], cwd);
      if (normalized === null || normalized.length === 0 || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);

      let exists = false;
      let isDirectory = false;
      if (existsSync(normalized)) {
        exists = true;
        const stats = statSync(normalized);
        isDirectory = stats.isDirectory();
      }

      results.push({
        path: normalized,
        display: formatDisplayPath(normalized, cwd),
        exists,
        isDirectory,
      });
    }
  }

  return results;
};

export const findLatestFileReference = (
  entries: SessionEntry[],
  cwd: string,
): FileReference | null => {
  const refs = collectRecentFileReferences(entries, cwd, 100);
  return refs.find((ref) => ref.exists) ?? null;
};
