import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import {
  loadEntriesFromFile,
  type FileEntry,
  type SessionHeader,
} from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js";
import type { SessionSummary } from "./schemas.js";
import type { SessionRecord } from "./session/types.js";

export interface SessionCatalogRecord {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  sessionName: string;
  messageCount: number;
  createdAt: number;
  modifiedAt: number;
  parentSessionId: string | null;
  parentSessionPath: string | null;
  persistence: "persistent";
  lifecycleStatus: "active" | "archived";
}

interface RawCatalogRecord {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  sessionName: string;
  messageCount: number;
  createdAt: number;
  modifiedAt: number;
  parentSessionPath: string | null;
}

export interface SessionCatalogOptions {
  rootDir?: string;
}

export class SessionCatalog {
  private readonly rootDir: string | undefined;
  private readonly recordsBySessionId = new Map<string, SessionCatalogRecord>();
  private readonly sessionPathById = new Map<string, string>();

  constructor(options: SessionCatalogOptions) {
    this.rootDir =
      options.rootDir !== undefined && options.rootDir.length > 0
        ? resolve(options.rootDir)
        : undefined;
    this.scan();
  }

  scan(): void {
    if (this.rootDir === undefined) {
      this.recordsBySessionId.clear();
      this.sessionPathById.clear();
      return;
    }

    const rawRecords = collectRawCatalogRecords(this.rootDir);
    const sessionIdByPath = new Map(
      rawRecords.map((record) => [record.sessionPath, record.sessionId]),
    );

    this.recordsBySessionId.clear();
    this.sessionPathById.clear();

    for (const rawRecord of rawRecords) {
      this.upsert(createCatalogRecord(rawRecord, sessionIdByPath, this.rootDir));
    }
  }

  list(): SessionCatalogRecord[] {
    return [...this.recordsBySessionId.values()];
  }

  get(sessionId: string): SessionCatalogRecord | undefined {
    return this.recordsBySessionId.get(sessionId);
  }

  getSessionPath(sessionId: string): string | undefined {
    return this.sessionPathById.get(sessionId);
  }

  archive(sessionId: string): SessionCatalogRecord {
    const record = this.requireRecord(sessionId);
    if (record.lifecycleStatus === "archived") {
      return record;
    }

    const archivedPath = archiveSessionPath(this.rootDir, record.sessionPath);
    mkdirSync(resolve(archivedPath, ".."), { recursive: true });
    renameSync(record.sessionPath, archivedPath);
    const archivedRecord = buildRawCatalogRecord(archivedPath);
    if (!archivedRecord) {
      throw new Error(`Failed to archive session ${sessionId}`);
    }
    const nextRecord = createMovedCatalogRecord(archivedRecord, record, this.rootDir);
    this.upsert(nextRecord);
    return nextRecord;
  }

  restore(sessionId: string): SessionCatalogRecord {
    const record = this.requireRecord(sessionId);
    if (record.lifecycleStatus === "active") {
      return record;
    }

    const restoredPath = restoreSessionPath(this.rootDir, record.sessionPath);
    mkdirSync(resolve(restoredPath, ".."), { recursive: true });
    renameSync(record.sessionPath, restoredPath);
    const restoredRecord = buildRawCatalogRecord(restoredPath);
    if (!restoredRecord) {
      throw new Error(`Failed to restore session ${sessionId}`);
    }
    const nextRecord = createMovedCatalogRecord(restoredRecord, record, this.rootDir);
    this.upsert(nextRecord);
    return nextRecord;
  }

  delete(sessionId: string): void {
    const record = this.requireRecord(sessionId);
    rmSync(record.sessionPath, { force: true });
    this.recordsBySessionId.delete(sessionId);
    this.sessionPathById.delete(sessionId);
  }

  registerPersistedRuntimeRecord(record: SessionRecord): void {
    const sessionPath = record.sessionStats.sessionFile;
    if (sessionPath === undefined || sessionPath.length === 0) {
      return;
    }

    const existing = this.recordsBySessionId.get(record.sessionId);

    this.upsert({
      sessionId: record.sessionId,
      sessionPath: resolve(sessionPath),
      cwd: record.cwd,
      sessionName: record.sessionName,
      messageCount: record.sessionStats.totalMessages,
      createdAt: record.createdAt,
      modifiedAt: record.updatedAt,
      parentSessionId: existing?.parentSessionId ?? null,
      parentSessionPath: existing?.parentSessionPath ?? null,
      persistence: "persistent",
      lifecycleStatus:
        existing?.lifecycleStatus ?? resolveLifecycleStatus(sessionPath, this.rootDir),
    });
  }

  listSummaries(input: {
    sessions: Map<string, SessionRecord>;
    syncFromRuntime: (record: SessionRecord) => void;
    getLastSessionStreamOffset: (sessionId: string) => string;
  }): SessionSummary[] {
    const summaries = new Map<string, SessionSummary>();

    for (const catalogRecord of this.recordsBySessionId.values()) {
      const loadedRecord = input.sessions.get(catalogRecord.sessionId);
      if (loadedRecord) {
        input.syncFromRuntime(loadedRecord);
        summaries.set(
          catalogRecord.sessionId,
          createSummaryFromRuntimeRecord(loadedRecord, {
            persistence: "persistent",
            lifecycleStatus: catalogRecord.lifecycleStatus,
            getLastSessionStreamOffset: input.getLastSessionStreamOffset,
            parentSessionId: catalogRecord.parentSessionId,
          }),
        );
        continue;
      }

      summaries.set(
        catalogRecord.sessionId,
        createSummaryFromCatalogRecord(catalogRecord, {
          getLastSessionStreamOffset: input.getLastSessionStreamOffset,
        }),
      );
    }

    for (const loadedRecord of input.sessions.values()) {
      if (summaries.has(loadedRecord.sessionId)) {
        continue;
      }

      input.syncFromRuntime(loadedRecord);
      summaries.set(
        loadedRecord.sessionId,
        createSummaryFromRuntimeRecord(loadedRecord, {
          persistence: loadedRecord.persistence,
          lifecycleStatus: "active",
          getLastSessionStreamOffset: input.getLastSessionStreamOffset,
          parentSessionId: null,
        }),
      );
    }

    return [...summaries.values()];
  }

  getSummary(input: {
    sessionId: string;
    sessions: Map<string, SessionRecord>;
    syncFromRuntime: (record: SessionRecord) => void;
    getLastSessionStreamOffset: (sessionId: string) => string;
  }): SessionSummary | undefined {
    const loadedRecord = input.sessions.get(input.sessionId);
    if (loadedRecord) {
      input.syncFromRuntime(loadedRecord);
      const catalogRecord = this.recordsBySessionId.get(input.sessionId);
      return createSummaryFromRuntimeRecord(loadedRecord, {
        persistence: catalogRecord?.persistence ?? loadedRecord.persistence,
        lifecycleStatus: catalogRecord?.lifecycleStatus ?? "active",
        getLastSessionStreamOffset: input.getLastSessionStreamOffset,
        parentSessionId: catalogRecord?.parentSessionId ?? null,
      });
    }

    const catalogRecord = this.recordsBySessionId.get(input.sessionId);
    if (!catalogRecord) {
      return undefined;
    }

    return createSummaryFromCatalogRecord(catalogRecord, {
      getLastSessionStreamOffset: input.getLastSessionStreamOffset,
    });
  }

  private upsert(record: SessionCatalogRecord): void {
    const existing = this.recordsBySessionId.get(record.sessionId);
    if (existing && existing.modifiedAt > record.modifiedAt) {
      return;
    }

    this.recordsBySessionId.set(record.sessionId, record);
    this.sessionPathById.set(record.sessionId, record.sessionPath);
  }

  private requireRecord(sessionId: string): SessionCatalogRecord {
    const record = this.recordsBySessionId.get(sessionId);
    if (!record) {
      throw new Error(`Session catalog record not found for ${sessionId}`);
    }
    return record;
  }
}

function collectRawCatalogRecords(rootDir: string): RawCatalogRecord[] {
  const sessionFiles = walkSessionFiles(rootDir);
  return sessionFiles
    .map((sessionPath) => buildRawCatalogRecord(sessionPath))
    .filter((record): record is RawCatalogRecord => record !== null);
}

function walkSessionFiles(rootDir: string): string[] {
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = resolve(rootDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkSessionFiles(entryPath));
        continue;
      }
      if (entry.isFile() && extname(entry.name) === ".jsonl") {
        files.push(entryPath);
      }
    }

    return files;
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingDirectoryError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function buildRawCatalogRecord(sessionPath: string): RawCatalogRecord | null {
  try {
    const entries = loadEntriesFromFile(sessionPath);
    const header = entries[0];
    if (!isSessionHeader(header)) {
      return null;
    }

    const stats = statSync(sessionPath);
    return {
      sessionId: header.id,
      sessionPath: resolve(sessionPath),
      cwd: header.cwd,
      sessionName: readSessionName(entries, header.id),
      messageCount: entries.filter((entry) => entry.type === "message").length,
      createdAt: new Date(header.timestamp).getTime(),
      modifiedAt: Math.trunc(stats.mtimeMs),
      parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : null,
    };
  } catch {
    return null;
  }
}

function isSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
  return (
    entry !== undefined &&
    entry.type === "session" &&
    typeof entry.id === "string" &&
    typeof entry.cwd === "string" &&
    typeof entry.timestamp === "string"
  );
}

function readSessionName(entries: FileEntry[], sessionId: string): string {
  let sessionName: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "session_info") {
      continue;
    }
    if (typeof entry.name === "string" && entry.name.trim().length > 0) {
      sessionName = entry.name.trim();
    }
  }

  return sessionName ?? basename(sessionId);
}

function createCatalogRecord(
  rawRecord: RawCatalogRecord,
  sessionIdByPath: Map<string, string>,
  rootDir?: string,
): SessionCatalogRecord {
  return {
    sessionId: rawRecord.sessionId,
    sessionPath: rawRecord.sessionPath,
    cwd: rawRecord.cwd,
    sessionName: rawRecord.sessionName,
    messageCount: rawRecord.messageCount,
    createdAt: rawRecord.createdAt,
    modifiedAt: rawRecord.modifiedAt,
    parentSessionPath: rawRecord.parentSessionPath,
    parentSessionId:
      rawRecord.parentSessionPath === null
        ? null
        : (sessionIdByPath.get(resolve(rawRecord.parentSessionPath)) ?? null),
    persistence: "persistent",
    lifecycleStatus: resolveLifecycleStatus(rawRecord.sessionPath, rootDir),
  };
}

function createMovedCatalogRecord(
  rawRecord: RawCatalogRecord,
  existingRecord: SessionCatalogRecord,
  rootDir?: string,
): SessionCatalogRecord {
  return {
    sessionId: rawRecord.sessionId,
    sessionPath: rawRecord.sessionPath,
    cwd: rawRecord.cwd,
    sessionName: rawRecord.sessionName,
    messageCount: rawRecord.messageCount,
    createdAt: rawRecord.createdAt,
    modifiedAt: rawRecord.modifiedAt,
    parentSessionId: existingRecord.parentSessionId,
    parentSessionPath: existingRecord.parentSessionPath ?? rawRecord.parentSessionPath,
    persistence: existingRecord.persistence,
    lifecycleStatus: resolveLifecycleStatus(rawRecord.sessionPath, rootDir),
  };
}

function resolveLifecycleStatus(
  sessionPath: string,
  rootDir: string | undefined,
): SessionCatalogRecord["lifecycleStatus"] {
  if (rootDir === undefined) {
    return "active";
  }
  const archiveRoot = resolve(rootDir, ".archive");
  const normalizedSessionPath = resolve(sessionPath);
  return isPathWithinRoot(normalizedSessionPath, archiveRoot) ? "archived" : "active";
}

function archiveSessionPath(rootDir: string | undefined, sessionPath: string): string {
  if (rootDir === undefined) {
    throw new Error("Session catalog root is required to archive sessions");
  }
  return resolve(rootDir, ".archive", relative(rootDir, resolve(sessionPath)));
}

function restoreSessionPath(rootDir: string | undefined, sessionPath: string): string {
  if (rootDir === undefined) {
    throw new Error("Session catalog root is required to restore sessions");
  }
  const archiveRoot = resolve(rootDir, ".archive");
  return resolve(rootDir, relative(archiveRoot, resolve(sessionPath)));
}

function isPathWithinRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function createSummaryFromCatalogRecord(
  record: SessionCatalogRecord,
  input: { getLastSessionStreamOffset: (sessionId: string) => string },
): SessionSummary {
  return {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    messageCount: record.messageCount,
    status: "idle",
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.modifiedAt,
    parentSessionId: record.parentSessionId,
    lifecycle: {
      persistence: record.persistence,
      loaded: false,
      state: record.lifecycleStatus,
    },
    lastSessionStreamOffset: input.getLastSessionStreamOffset(record.sessionId),
  };
}

function createSummaryFromRuntimeRecord(
  record: SessionRecord,
  input: {
    persistence: "persistent" | "ephemeral";
    lifecycleStatus: "active" | "archived";
    getLastSessionStreamOffset: (sessionId: string) => string;
    parentSessionId: string | null;
  },
): SessionSummary {
  return {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    messageCount: record.sessionStats.totalMessages,
    status: record.status,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    parentSessionId: input.parentSessionId,
    lifecycle: {
      persistence: input.persistence,
      loaded: true,
      state: input.lifecycleStatus,
    },
    lastSessionStreamOffset: input.getLastSessionStreamOffset(record.sessionId),
  };
}
