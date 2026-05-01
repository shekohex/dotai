import { readFileSync } from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { sanitizeSessionEntry } from "../schema-normalization.js";

export type CommittedSessionHistory = {
  entries: SessionEntry[];
  transcript: AgentMessage[];
  totalEntries: number;
  totalTranscriptMessages: number;
  entriesLimit: number;
  entriesOffset: number;
};

export function readCommittedSessionHistory(input: {
  entries: SessionEntry[];
  entriesLimit?: number;
  entriesOffset?: number;
}): CommittedSessionHistory {
  const entriesLimit = input.entriesLimit ?? 100;
  const entriesOffset = input.entriesOffset ?? 0;
  const normalizedEntries = normalizeCommittedSessionEntries(input.entries);
  const transcript = normalizedEntries
    .filter(
      (entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message",
    )
    .map((entry) => structuredClone(entry.message));

  return {
    entries: sliceTrailingItems(normalizedEntries, entriesLimit, entriesOffset),
    transcript: sliceTrailingItems(transcript, entriesLimit, entriesOffset),
    totalEntries: normalizedEntries.length,
    totalTranscriptMessages: transcript.length,
    entriesLimit,
    entriesOffset,
  };
}

export function loadCommittedSessionHistoryFromFile(input: {
  sessionPath: string;
  entriesLimit?: number;
  entriesOffset?: number;
}): CommittedSessionHistory {
  const content = readFileSync(input.sessionPath, "utf8");
  const entries = parseSessionEntries(content)
    .filter((entry: FileEntry): entry is SessionEntry => isSessionEntry(entry))
    .map((entry: SessionEntry) => cloneSessionEntry(entry));
  return readCommittedSessionHistory({
    entries,
    entriesLimit: input.entriesLimit,
    entriesOffset: input.entriesOffset,
  });
}

export function normalizeCommittedSessionEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries
    .filter((entry) => isCommittedSessionEntry(entry))
    .map((entry) => cloneSessionEntry(entry));
}

function sliceTrailingItems<T>(items: T[], limit: number, offset: number): T[] {
  if (limit <= 0) {
    return [];
  }
  const normalizedOffset = Math.max(0, offset);
  const exclusiveEnd = Math.max(0, items.length - normalizedOffset);
  const start = Math.max(0, exclusiveEnd - limit);
  return items.slice(start, exclusiveEnd);
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== "session" && isCommittedSessionEntry(entry);
}

function isCommittedSessionEntry(entry: SessionEntry): boolean {
  return entry.type !== "session_info";
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return sanitizeSessionEntry({
    ...entry,
    ...(entry.type === "message" ? { message: structuredClone(entry.message) } : {}),
    ...(entry.type === "custom" ? { data: structuredClone(entry.data) } : {}),
    ...(entry.type === "custom_message" ? { content: structuredClone(entry.content) } : {}),
  });
}
