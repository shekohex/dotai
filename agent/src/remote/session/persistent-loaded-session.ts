import { rmSync } from "node:fs";
import type { SessionSnapshot } from "../schemas.js";
import type { SessionCatalog, SessionCatalogRecord } from "../session-catalog.js";
import { flushPersistedSessionManagerToDisk } from "../session-manager-storage.js";
import type { SessionRecord } from "./types.js";

export function shouldForkLoadedSession(
  loadedRecord: SessionRecord | undefined,
  _catalogHasSession: boolean,
  _entryId: string | undefined,
): boolean {
  if (loadedRecord === undefined) {
    return false;
  }
  return loadedRecord.persistence === "ephemeral";
}

export function promoteLoadedPersistentSessionToCatalog(input: {
  loadedRecord: SessionRecord | undefined;
  syncFromRuntime: (record: SessionRecord, options?: { updateTimestamp?: boolean }) => void;
  catalog: SessionCatalog;
}): void {
  const loaded = input.loadedRecord;
  if (loaded === undefined || loaded.persistence !== "persistent") {
    return;
  }

  input.syncFromRuntime(loaded, { updateTimestamp: false });
  const runtimeSession = loaded.runtime.session;
  if (runtimeSession !== undefined) {
    flushPersistedSessionManagerToDisk(runtimeSession.sessionManager);
    input.syncFromRuntime(loaded, { updateTimestamp: false });
  }
  input.catalog.registerPersistedRuntimeRecord(loaded);
}

export function loadRecordForFork(input: {
  loadedRecord: SessionRecord | undefined;
  sessionId: string;
  entryId: string | undefined;
  ensureLoaded: (sessionId: string) => Promise<SessionRecord>;
}): Promise<SessionRecord | undefined> {
  if (input.loadedRecord !== undefined || input.entryId === undefined) {
    return Promise.resolve(input.loadedRecord);
  }
  return input.ensureLoaded(input.sessionId);
}

export function buildReloadResourcePatch(record: SessionRecord): SessionSnapshot["resources"] {
  return {
    skills: record.resources.skills.map((skill) => ({ ...skill })),
    prompts: record.resources.prompts.map((prompt) => ({ ...prompt })),
    themes: record.resources.themes.map((theme) => ({ ...theme })),
    ...(record.resources.modes === undefined
      ? {}
      : { modes: structuredClone(record.resources.modes) }),
    systemPrompt: record.resources.systemPrompt,
    appendSystemPrompt: [...record.resources.appendSystemPrompt],
  };
}

export function didCatalogRecordChange(
  previousRecord: SessionCatalogRecord,
  nextRecord: SessionCatalogRecord,
): boolean {
  return (
    previousRecord.sessionPath !== nextRecord.sessionPath ||
    previousRecord.cwd !== nextRecord.cwd ||
    previousRecord.sessionName !== nextRecord.sessionName ||
    previousRecord.modifiedAt !== nextRecord.modifiedAt ||
    previousRecord.parentSessionId !== nextRecord.parentSessionId ||
    previousRecord.lifecycleStatus !== nextRecord.lifecycleStatus
  );
}

export function didCatalogLocationChange(
  previousRecord: SessionCatalogRecord,
  nextRecord: SessionCatalogRecord,
): boolean {
  return (
    previousRecord.sessionPath !== nextRecord.sessionPath ||
    previousRecord.lifecycleStatus !== nextRecord.lifecycleStatus
  );
}

export function isRuntimeSessionBusy(
  record: SessionRecord,
  session: NonNullable<SessionRecord["runtime"]>["session"],
): boolean {
  return session.isStreaming || session.isCompacting || record.queue.depth > 0;
}

export function shouldEvictLoadedRuntime(
  record: SessionRecord,
  now: number,
  runtimeIdleTtlMs: number | undefined,
  canReloadPersistedSessions: boolean,
): boolean {
  if (record.persistence !== "persistent") {
    return false;
  }
  if (!canReloadPersistedSessions) {
    return false;
  }
  if (record.presence.size > 0) {
    return false;
  }
  const session = record.runtime.session;
  if (session === undefined) {
    return false;
  }
  if (isRuntimeSessionBusy(record, session)) {
    return false;
  }
  if (runtimeIdleTtlMs === undefined) {
    return false;
  }
  return now - record.updatedAt >= runtimeIdleTtlMs;
}

export function shouldCollectDetachedEmptySession(
  record: SessionRecord,
  _sessionFilePath: string | undefined,
): boolean {
  if (record.presence.size > 0) {
    return false;
  }
  if (record.queue.depth > 0) {
    return false;
  }
  const runtimeSession = record.runtime.session;
  if (runtimeSession?.isStreaming || runtimeSession?.isCompacting) {
    return false;
  }
  if (record.sessionStats.totalMessages > 0) {
    return false;
  }
  if (record.persistence === "ephemeral") {
    return true;
  }
  return true;
}

export function readLoadedSessionFilePath(record: SessionRecord): string | undefined {
  const statsPath = record.sessionStats.sessionFile;
  if (statsPath !== undefined && statsPath.length > 0) {
    return statsPath;
  }

  const runtimeSession = record.runtime.session;
  if (runtimeSession === undefined) {
    return undefined;
  }

  const managerPath = runtimeSession.sessionManager.getSessionFile();
  return managerPath !== undefined && managerPath.length > 0 ? managerPath : undefined;
}

export function deleteSessionFileIfPresent(sessionFilePath: string | undefined): void {
  if (sessionFilePath === undefined || sessionFilePath.length === 0) {
    return;
  }
  rmSync(sessionFilePath, { force: true });
}
