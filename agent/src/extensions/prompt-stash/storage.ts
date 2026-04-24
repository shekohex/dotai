import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const STASH_VERSION = 1;
export const MAX_STASH_ENTRIES = 50;
const STASH_FILE_NAME = "prompt-stash.jsonl";

const PromptStashEntrySchema = Type.Object(
  {
    version: Type.Literal(STASH_VERSION),
    id: Type.String(),
    text: Type.String(),
    createdAt: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type PromptStashEntry = Static<typeof PromptStashEntrySchema>;

function readErrorCode(error: unknown): string | undefined {
  if (!hasCode(error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}

function hasCode(value: unknown): value is { code?: unknown } {
  return value !== null && typeof value === "object" && "code" in value;
}

function expandUserPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function getResolvedAgentDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  return agentDir !== undefined && agentDir.length > 0 ? expandUserPath(agentDir) : getAgentDir();
}

export function getStashFilePath(): string {
  return path.join(getResolvedAgentDir(), STASH_FILE_NAME);
}

async function readStashEntries(): Promise<{ entries: PromptStashEntry[]; dirty: boolean }> {
  const stashFilePath = getStashFilePath();
  try {
    const raw = await readFile(stashFilePath, "utf8");
    if (!raw) {
      return { entries: [], dirty: false };
    }
    return parseRawStashEntries(raw);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return { entries: [], dirty: false };
    }
    throw error;
  }
}

function parseRawStashEntries(raw: string): { entries: PromptStashEntry[]; dirty: boolean } {
  const normalized = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  const dirty = normalized.endsWith("\n");
  if (dirty) {
    lines.pop();
  }
  const parsed = parseStashLines(lines, dirty);
  const normalizedEntries = parsed.entries.slice(0, MAX_STASH_ENTRIES);
  return {
    entries: normalizedEntries,
    dirty: parsed.dirty || normalizedEntries.length !== parsed.entries.length,
  };
}

function parseStashLines(
  lines: string[],
  dirty: boolean,
): { entries: PromptStashEntry[]; dirty: boolean } {
  const entries: PromptStashEntry[] = [];
  const seenIds = new Set<string>();
  let needsRewrite = dirty;
  for (const line of lines) {
    const parsedLine = parseStashLine(line);
    if (!parsedLine) {
      needsRewrite = true;
      continue;
    }
    if (seenIds.has(parsedLine.entry.id)) {
      needsRewrite = true;
      continue;
    }
    seenIds.add(parsedLine.entry.id);
    entries.push(parsedLine.entry);
    needsRewrite = needsRewrite || parsedLine.dirty;
  }
  return { entries, dirty: needsRewrite };
}

function parseStashLine(line: string): { entry: PromptStashEntry; dirty: boolean } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = Value.Parse(PromptStashEntrySchema, JSON.parse(trimmed));
    return { entry: parsed, dirty: line !== JSON.stringify(parsed) };
  } catch {
    return undefined;
  }
}

async function writeStashEntries(entries: PromptStashEntry[]): Promise<void> {
  const stashFilePath = getStashFilePath();
  await mkdir(path.dirname(stashFilePath), { recursive: true });
  const content = entries
    .slice(0, MAX_STASH_ENTRIES)
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await writeFile(stashFilePath, content, "utf8");
}

export async function loadStashEntries(_cwd: string): Promise<PromptStashEntry[]> {
  const { entries, dirty } = await readStashEntries();
  if (dirty) {
    await writeStashEntries(entries);
  }
  return entries;
}

export async function saveStashEntries(_cwd: string, entries: PromptStashEntry[]): Promise<void> {
  await writeStashEntries(entries.slice(0, MAX_STASH_ENTRIES));
}
