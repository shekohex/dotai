import { readFileSync } from "node:fs";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { sanitizeSessionEntry } from "../schema-normalization.js";
import type { RemoteSessionEntry } from "../schemas-core.js";
import { REMOTE_AUTHORITATIVE_SESSION_METADATA_ENTRY } from "./authoritative-session-metadata.js";
import {
  REMOTE_DURABLE_EXTENSION_STATE_ENTRY,
  REMOTE_RUNTIME_TRANSITION_ENTRY,
  REMOTE_SESSION_VERSION_ENTRY,
} from "./durable-runtime-state.js";

export type CommittedSessionHistory = {
  entries: RemoteSessionEntry[];
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
      (entry): entry is Extract<RemoteSessionEntry, { type: "message" }> =>
        entry.type === "message",
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

export function normalizeCommittedSessionEntries(entries: SessionEntry[]): RemoteSessionEntry[] {
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
  return entry.type !== "session_info" && !isInternalRemoteCustomEntry(entry);
}

function isInternalRemoteCustomEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "custom" &&
    (entry.customType === REMOTE_RUNTIME_TRANSITION_ENTRY ||
      entry.customType === REMOTE_SESSION_VERSION_ENTRY ||
      entry.customType === REMOTE_DURABLE_EXTENSION_STATE_ENTRY ||
      entry.customType === REMOTE_AUTHORITATIVE_SESSION_METADATA_ENTRY)
  );
}

function cloneSessionEntry(entry: SessionEntry): RemoteSessionEntry {
  return sanitizeSessionEntry({
    ...entry,
    ...(entry.type === "message" ? { message: structuredClone(entry.message) } : {}),
    ...(entry.type === "custom" ? { data: structuredClone(entry.data) } : {}),
    ...(entry.type === "custom_message" ? { content: structuredClone(entry.content) } : {}),
  });
}
