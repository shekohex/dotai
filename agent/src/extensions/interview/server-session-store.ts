import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { getAgentRuntime } from "./settings.js";
import type { QuestionsFile } from "./schema.js";
import type { SessionsFile, SessionEntry } from "./server-contract.js";

const SessionEntrySchema = Type.Object({
  id: Type.String(),
  url: Type.String(),
  cwd: Type.String(),
  gitBranch: Type.Union([Type.String(), Type.Null()]),
  title: Type.String(),
  startedAt: Type.Number(),
  lastSeen: Type.Number(),
});
const SessionsFileSchema = Type.Object({
  sessions: Type.Array(SessionEntrySchema),
});

export const AGENT_RUNTIME_DIR = getAgentRuntime();
const SESSIONS_FILE = join(AGENT_RUNTIME_DIR, "interview-sessions.json");
const RECOVERY_DIR = join(AGENT_RUNTIME_DIR, "interview-recovery");
export const SNAPSHOTS_DIR = join(AGENT_RUNTIME_DIR, "interview-snapshots");
export const STALE_THRESHOLD_MS = 30_000;
const STALE_PRUNE_MS = 60_000;
const RECOVERY_MAX_AGE_DAYS = 7;

function ensureRuntimeDir(): void {
  if (!existsSync(AGENT_RUNTIME_DIR)) {
    mkdirSync(AGENT_RUNTIME_DIR, { recursive: true });
  }
}

function parseSessionsFile(value: unknown): SessionsFile {
  if (!Value.Check(SessionsFileSchema, value)) {
    return { sessions: [] };
  }
  return Value.Parse(SessionsFileSchema, value);
}

function readSessions(): SessionsFile {
  try {
    if (!existsSync(SESSIONS_FILE)) {
      return { sessions: [] };
    }
    const parsed: unknown = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    return parseSessionsFile(parsed);
  } catch {
    return { sessions: [] };
  }
}

function writeSessions(data: SessionsFile): void {
  ensureRuntimeDir();
  const tempFile = `${SESSIONS_FILE}.tmp`;
  writeFileSync(tempFile, JSON.stringify(data, null, 2));
  renameSync(tempFile, SESSIONS_FILE);
}

function pruneStaleSessions(sessions: SessionEntry[]): SessionEntry[] {
  const now = Date.now();
  return sessions.filter((session) => now - session.lastSeen < STALE_PRUNE_MS);
}

function listSessions(): SessionEntry[] {
  const data = readSessions();
  const pruned = pruneStaleSessions(data.sessions);
  if (pruned.length !== data.sessions.length) {
    writeSessions({ sessions: pruned });
  }
  return pruned;
}

export function touchSession(entry: SessionEntry): void {
  const data = readSessions();
  data.sessions = pruneStaleSessions(data.sessions);
  const existing = data.sessions.find((session) => session.id === entry.id);
  if (existing === undefined) {
    data.sessions.push({ ...entry, lastSeen: Date.now() });
  } else {
    existing.lastSeen = Date.now();
    existing.url = entry.url;
    existing.cwd = entry.cwd;
    existing.gitBranch = entry.gitBranch;
    existing.title = entry.title;
    existing.startedAt = entry.startedAt;
  }
  writeSessions(data);
}

export function registerSession(entry: SessionEntry): void {
  touchSession(entry);
}

export function unregisterSession(sessionId: string): void {
  const data = readSessions();
  data.sessions = data.sessions.filter((session) => session.id !== sessionId);
  writeSessions(data);
}

export function getActiveSessions(): SessionEntry[] {
  const now = Date.now();
  return listSessions().filter((session) => now - session.lastSeen < STALE_THRESHOLD_MS);
}

function ensureRecoveryDir(): void {
  if (!existsSync(RECOVERY_DIR)) {
    mkdirSync(RECOVERY_DIR, { recursive: true });
  }
}

export function cleanupOldRecoveryFiles(): void {
  if (!existsSync(RECOVERY_DIR)) {
    return;
  }
  const now = Date.now();
  const maxAge = RECOVERY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const file of readdirSync(RECOVERY_DIR)) {
      const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})_/);
      if (dateMatch?.[1] === undefined) {
        continue;
      }
      const fileDate = new Date(dateMatch[1]).getTime();
      if (now - fileDate > maxAge) {
        unlinkSync(join(RECOVERY_DIR, file));
      }
    }
  } catch {}
}

export function sanitizeForFilename(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-").slice(0, 50);
}

export function saveToRecovery(
  questions: QuestionsFile,
  cwd: string,
  gitBranch: string | null,
  sessionId: string,
): string {
  ensureRecoveryDir();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 8).replaceAll(":", "");
  const project = sanitizeForFilename(basename(cwd) || "unknown");
  const branch = sanitizeForFilename(gitBranch ?? "nogit");
  const filename = `${date}_${time}_${project}_${branch}_${sessionId.slice(0, 8)}.json`;
  const filePath = join(RECOVERY_DIR, filename);
  writeFileSync(filePath, JSON.stringify(questions, null, 2));
  return filePath;
}

export function normalizePath(filePath: string): string {
  const home = homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

export function getGitBranch(cwd: string): string | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}
