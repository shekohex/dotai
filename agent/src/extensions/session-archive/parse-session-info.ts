import { readFile, stat } from "node:fs/promises";
import {
  parseSessionEntries,
  type FileEntry,
  type SessionInfo,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

export type SessionListProgress = (loaded: number, total: number) => void;

function extractMessage(entry: SessionMessageEntry): { text: string; time: number | null } {
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant") {
    return { text: "", time: null };
  }
  const time = typeof message.timestamp === "number" ? message.timestamp : null;
  const content = message.content;
  if (typeof content === "string") {
    return { text: content, time };
  }
  const text = content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  return { text, time };
}

function resolveModified(
  lastActivityTime: number | null,
  headerTime: number,
  fallback: Date,
): Date {
  if (lastActivityTime !== null) return new Date(lastActivityTime);
  if (Number.isNaN(headerTime)) return fallback;
  return new Date(headerTime);
}

export async function parseSessionInfo(filePath: string): Promise<SessionInfo | null> {
  try {
    const content = await readFile(filePath, "utf8");
    const entries = parseSessionEntries(content);
    if (entries.length === 0) return null;

    const header = entries.find(
      (entry): entry is Extract<FileEntry, { type: "session" }> => entry.type === "session",
    );
    if (header === undefined) return null;

    let messageCount = 0;
    let firstMessage = "";
    let lastActivityTime: number | null = null;
    const allMessages: string[] = [];
    let name: string | undefined;

    for (const entry of entries) {
      if (entry.type === "session_info") {
        const trimmed = entry.name?.trim();
        name = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
      }
      if (entry.type !== "message") continue;
      messageCount += 1;
      const { text, time } = extractMessage(entry);
      if (time !== null) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, time);
      }
      if (text.length === 0) continue;
      allMessages.push(text);
      if (firstMessage.length === 0 && entry.message.role === "user") {
        firstMessage = text;
      }
    }

    const headerTime = new Date(header.timestamp).getTime();
    const stats = await stat(filePath);
    const modified = resolveModified(lastActivityTime, headerTime, stats.mtime);

    const info: SessionInfo = {
      path: filePath,
      id: header.id,
      cwd: header.cwd,
      created: new Date(header.timestamp),
      modified,
      messageCount,
      firstMessage: firstMessage.length > 0 ? firstMessage : "(no messages)",
      allMessagesText: allMessages.join(" "),
    };
    if (name !== undefined) info.name = name;
    if (header.parentSession !== undefined) info.parentSessionPath = header.parentSession;
    return info;
  } catch {
    return null;
  }
}

const MAX_CONCURRENT = 10;

export async function parseSessionInfos(
  files: string[],
  onProgress?: SessionListProgress,
): Promise<SessionInfo[]> {
  if (files.length === 0) return [];

  const results: SessionInfo[] = [];
  let loaded = 0;
  let nextIndex = 0;
  const inFlight = new Set<Promise<void>>();

  const startNext = (): void => {
    const file = files[nextIndex];
    if (file === undefined) return;
    nextIndex += 1;
    const task = parseSessionInfo(file).then((parsed) => {
      if (parsed !== null) results.push(parsed);
    });
    inFlight.add(task);
    void task.finally(() => {
      inFlight.delete(task);
      loaded += 1;
      onProgress?.(loaded, files.length);
    });
  };

  while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT) {
    startNext();
  }
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT) {
      startNext();
    }
  }

  return results;
}
