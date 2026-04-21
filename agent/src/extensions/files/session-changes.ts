import path from "node:path";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { FileToolName, SessionFileChange } from "./model.js";
import { toCanonicalPath } from "./path-utils.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isFileToolName = (value: unknown): value is FileToolName =>
  value === "write" || value === "edit";

const collectFileToolCalls = (
  entries: SessionEntry[],
): Map<string, { path: string; name: FileToolName }> => {
  const toolCalls = new Map<string, { path: string; name: FileToolName }>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      continue;
    }

    for (const block of msg.content) {
      if (block.type !== "toolCall" || !isFileToolName(block.name)) {
        continue;
      }

      const argumentsRecord = isRecord(block.arguments) ? block.arguments : undefined;
      const filePath = argumentsRecord?.path;
      if (typeof filePath === "string" && filePath.length > 0) {
        toolCalls.set(block.id, { path: filePath, name: block.name });
      }
    }
  }

  return toolCalls;
};

const addSessionFileChange = (
  fileMap: Map<string, SessionFileChange>,
  canonicalPath: string,
  operation: FileToolName,
  timestamp: number,
): void => {
  const existing = fileMap.get(canonicalPath);
  if (existing) {
    existing.operations.add(operation);
    if (timestamp > existing.lastTimestamp) {
      existing.lastTimestamp = timestamp;
    }
    return;
  }

  fileMap.set(canonicalPath, {
    operations: new Set([operation]),
    lastTimestamp: timestamp,
  });
};

const resolveToolCallCanonicalPath = (
  toolCallPath: string,
  cwd: string,
): { canonicalPath: string; isDirectory: boolean } | null => {
  const resolvedPath = path.isAbsolute(toolCallPath)
    ? toolCallPath
    : path.resolve(cwd, toolCallPath);
  return toCanonicalPath(resolvedPath);
};

export const collectSessionFileChanges = (
  entries: SessionEntry[],
  cwd: string,
): Map<string, SessionFileChange> => {
  const toolCalls = collectFileToolCalls(entries);

  const fileMap = new Map<string, SessionFileChange>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = entry.message;

    if (msg.role === "toolResult") {
      const toolCall = toolCalls.get(msg.toolCallId);
      if (!toolCall) continue;

      const canonical = resolveToolCallCanonicalPath(toolCall.path, cwd);
      if (!canonical) {
        continue;
      }

      addSessionFileChange(fileMap, canonical.canonicalPath, toolCall.name, msg.timestamp);
    }
  }

  return fileMap;
};
