import { readdirSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
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
  createdAt: number;
  modifiedAt: number;
  parentSessionId: string | null;
  parentSessionPath: string | null;
  persistence: "persistent";
  lifecycleStatus: "active";
}

interface RawCatalogRecord {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  sessionName: string;
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
      const record: SessionCatalogRecord = {
        sessionId: rawRecord.sessionId,
        sessionPath: rawRecord.sessionPath,
        cwd: rawRecord.cwd,
        sessionName: rawRecord.sessionName,
        createdAt: rawRecord.createdAt,
        modifiedAt: rawRecord.modifiedAt,
        parentSessionPath: rawRecord.parentSessionPath,
        parentSessionId:
          rawRecord.parentSessionPath === null
            ? null
            : (sessionIdByPath.get(resolve(rawRecord.parentSessionPath)) ?? null),
        persistence: "persistent",
        lifecycleStatus: "active",
      };
      this.upsert(record);
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

  registerPersistedRuntimeRecord(record: SessionRecord): void {
    const sessionPath = record.sessionStats.sessionFile;
    if (sessionPath === undefined || sessionPath.length === 0) {
      return;
    }

    this.upsert({
      sessionId: record.sessionId,
      sessionPath: resolve(sessionPath),
      cwd: record.cwd,
      sessionName: record.sessionName,
      createdAt: record.createdAt,
      modifiedAt: record.updatedAt,
      parentSessionId: null,
      parentSessionPath: null,
      persistence: "persistent",
      lifecycleStatus: "active",
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
          persistence: isPersistentSessionFile(loadedRecord.sessionStats.sessionFile)
            ? "persistent"
            : "ephemeral",
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
      let persistence: "persistent" | "ephemeral" = "ephemeral";
      if (catalogRecord || isPersistentSessionFile(loadedRecord.sessionStats.sessionFile)) {
        persistence = "persistent";
      }
      return createSummaryFromRuntimeRecord(loadedRecord, {
        persistence,
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

function isPersistentSessionFile(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function createSummaryFromCatalogRecord(
  record: SessionCatalogRecord,
  input: { getLastSessionStreamOffset: (sessionId: string) => string },
): SessionSummary {
  return {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
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
    getLastSessionStreamOffset: (sessionId: string) => string;
    parentSessionId: string | null;
  },
): SessionSummary {
  return {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    status: record.status,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    parentSessionId: input.parentSessionId,
    lifecycle: {
      persistence: input.persistence,
      loaded: true,
      state: "active",
    },
    lastSessionStreamOffset: input.getLastSessionStreamOffset(record.sessionId),
  };
}
