import { SessionManager, type AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { AuthSession } from "../auth.js";
import { RemoteError } from "../errors.js";
import type { SessionCatalogRecord } from "../session-catalog.js";
import type { ForkSessionRequest, ForkSessionResponse } from "../schemas.js";
import { createSessionRecord, type SessionRecord } from "./deps.js";

export function readForkMessagesFromSessionManager(
  sessionManager: SessionManager,
): Array<{ entryId: string; text: string }> {
  const messages: Array<{ entryId: string; text: string }> = [];

  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "user") {
      continue;
    }
    const text = extractUserMessageText(entry.message.content);
    if (text.length === 0) {
      continue;
    }
    messages.push({ entryId: entry.id, text });
  }

  return messages;
}

export async function forkPersistentSessionRecord(input: {
  sessionId: string;
  request: ForkSessionRequest;
  client: AuthSession;
  connectionId?: string;
  catalogRecord: SessionCatalogRecord;
  loadedRuntimeSession?: AgentSessionRuntime["session"];
  runtimeFactoryLoad?: (request: {
    sessionId: string;
    sessionPath: string;
    cwd: string;
  }) => Promise<AgentSessionRuntime>;
  readRuntimeExtensionMetadata: (runtime: AgentSessionRuntime) => SessionRecord["extensions"];
  initializeRuntimeRecord: (
    record: SessionRecord,
    input: {
      initializedAt: number;
      syncSessionNameToRuntime: boolean;
      flushPersistedSessionManager: boolean;
    },
  ) => Promise<void>;
  registerCreatedSessionRecord: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    createdAt: number,
  ) => void;
  getAppStreamOffset: () => string;
  now: () => number;
}): Promise<ForkSessionResponse> {
  const sourceManager =
    input.request.entryId !== undefined && input.loadedRuntimeSession !== undefined
      ? input.loadedRuntimeSession.sessionManager
      : SessionManager.open(input.catalogRecord.sessionPath);
  const targetWorkspaceCwd = input.request.workspaceCwd ?? input.catalogRecord.cwd;

  let forkedSessionManager: SessionManager;
  let selectedText: string | undefined;
  const { entryId } = input.request;
  if (entryId === undefined) {
    forkedSessionManager = SessionManager.forkFrom(
      input.catalogRecord.sessionPath,
      targetWorkspaceCwd,
      sourceManager.getSessionDir(),
    );
  } else {
    const position = input.request.position ?? "before";
    const selectedEntry = sourceManager.getEntry(entryId);
    if (selectedEntry === undefined) {
      throw new RemoteError("Invalid entry ID for forking", 404);
    }

    if (position === "at") {
      const forkedSessionPath = sourceManager.createBranchedSession(selectedEntry.id);
      if (forkedSessionPath === undefined) {
        throw new RemoteError("Failed to create forked session", 409);
      }
      forkedSessionManager = SessionManager.open(forkedSessionPath);
    } else {
      if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
        throw new RemoteError("Invalid entry ID for forking", 404);
      }
      selectedText = extractUserMessageText(selectedEntry.message.content);
      const targetLeafId = selectedEntry.parentId;
      if (targetLeafId === null) {
        forkedSessionManager = SessionManager.create(
          targetWorkspaceCwd,
          sourceManager.getSessionDir(),
        );
        forkedSessionManager.newSession({ parentSession: input.catalogRecord.sessionPath });
      } else {
        const forkedSessionPath = sourceManager.createBranchedSession(targetLeafId);
        if (forkedSessionPath === undefined) {
          throw new RemoteError("Failed to create forked session", 409);
        }
        forkedSessionManager = SessionManager.open(forkedSessionPath);
      }
    }
  }

  const forkedSessionFile = forkedSessionManager.getSessionFile();
  if (forkedSessionFile === undefined || input.runtimeFactoryLoad === undefined) {
    throw new RemoteError("Session runtime is unavailable", 409);
  }

  const forkedSessionId = forkedSessionManager.getSessionId();
  const loadedAt = input.now();
  const runtime = await input.runtimeFactoryLoad({
    sessionId: forkedSessionId,
    sessionPath: forkedSessionFile,
    cwd: forkedSessionManager.getCwd(),
  });
  const record = createSessionRecord({
    sessionId: forkedSessionId,
    sessionName: input.catalogRecord.sessionName,
    persistence: "persistent",
    createdAt: loadedAt,
    updatedAt: loadedAt,
    runtime,
    lastAppStreamOffsetSeenByServer: input.getAppStreamOffset(),
    readRuntimeExtensionMetadata: (targetRuntime) =>
      input.readRuntimeExtensionMetadata(targetRuntime),
  });
  await input.initializeRuntimeRecord(record, {
    initializedAt: loadedAt,
    syncSessionNameToRuntime: false,
    flushPersistedSessionManager: false,
  });
  input.registerCreatedSessionRecord(record, input.client, input.connectionId, loadedAt);
  const response: ForkSessionResponse = {
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    status: record.status,
  };
  if (selectedText !== undefined) {
    response.selectedText = selectedText;
  }
  return response;
}

export async function forkEphemeralLoadedSessionRecord(input: {
  record: SessionRecord;
  request: ForkSessionRequest;
  client: AuthSession;
  connectionId?: string;
  syncFromRuntime: (
    record: SessionRecord,
    options?: { updateTimestamp?: boolean; syncResources?: boolean },
  ) => void;
  deleteLoadedRuntime: (sessionId: string) => void;
  registerPersistedRuntimeRecord: (record: SessionRecord) => void;
  registerCreatedSessionRecord: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    createdAt: number,
  ) => void;
  now: () => number;
}): Promise<ForkSessionResponse> {
  const session = input.record.runtime.session;
  if (input.request.entryId === undefined) {
    throw new RemoteError("Ephemeral session fork requires entryId", 409);
  }

  const result = await input.record.runtime.fork(input.request.entryId, {
    position: input.request.position,
  });
  if (result.cancelled) {
    throw new RemoteError("Session fork cancelled", 409);
  }

  const forkedSessionId = session.sessionManager.getSessionId();
  input.deleteLoadedRuntime(input.record.sessionId);
  input.record.sessionId = forkedSessionId;
  input.record.persistence = session.sessionManager.isPersisted() ? "persistent" : "ephemeral";
  input.record.createdAt = input.now();
  input.record.updatedAt = input.record.createdAt;
  input.syncFromRuntime(input.record, { updateTimestamp: false, syncResources: true });
  input.registerPersistedRuntimeRecord(input.record);
  input.registerCreatedSessionRecord(
    input.record,
    input.client,
    input.connectionId,
    input.record.createdAt,
  );
  const response: ForkSessionResponse = {
    sessionId: input.record.sessionId,
    sessionName: input.record.sessionName,
    status: input.record.status,
  };
  if (result.selectedText !== undefined) {
    response.selectedText = result.selectedText;
  }
  return response;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
  }

  return "";
}
