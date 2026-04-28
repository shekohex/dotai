import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AgentSessionEvent,
  SessionEntry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

type SessionManagerMessage = Parameters<SessionManager["appendMessage"]>[0];
type SessionManagerCustomMessage = Extract<AgentMessage, { role: "custom" }>;

type SessionManagerInternals = {
  fileEntries: unknown[];
  byId: Map<string, SessionEntry>;
  labelsById: Map<string, string>;
  labelTimestampsById: Map<string, string>;
  leafId: string | null;
};

export function initializeMirroredSessionManager(input: {
  sessionManager: SessionManager;
  sessionId: string;
  sessionName: string;
  entries: SessionEntry[];
  leafId: string | null;
}): void {
  input.sessionManager.newSession({ id: input.sessionId });
  rehydrateMirroredSessionManager({
    sessionManager: input.sessionManager,
    sessionId: input.sessionId,
    sessionName: input.sessionName,
    entries: input.entries,
    leafId: input.leafId,
  });
}

export function rehydrateMirroredSessionManager(input: {
  sessionManager: SessionManager;
  sessionId: string;
  sessionName?: string;
  entries: SessionEntry[];
  leafId: string | null;
}): void {
  input.sessionManager.newSession({ id: input.sessionId });
  const header = input.sessionManager.getHeader();
  if (!header) {
    return;
  }

  const entries = input.entries;

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const labelsById = new Map<string, string>();
  const labelTimestampsById = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type !== "label") {
      continue;
    }
    if (entry.label !== undefined && entry.label.length > 0) {
      labelsById.set(entry.targetId, entry.label);
      labelTimestampsById.set(entry.targetId, entry.timestamp);
      continue;
    }
    labelsById.delete(entry.targetId);
    labelTimestampsById.delete(entry.targetId);
  }

  setSessionManagerInternals(input.sessionManager, {
    fileEntries: [header, ...entries],
    byId,
    labelsById,
    labelTimestampsById,
    leafId: input.leafId,
  });
}

export function mirrorSessionEventMessage(
  sessionManager: SessionManager,
  event: AgentSessionEvent,
): void {
  if (event.type !== "message_end") {
    return;
  }

  appendSessionManagerMessage(sessionManager, event.message);
}

function appendSessionManagerMessage(sessionManager: SessionManager, message: AgentMessage): void {
  if (isSessionManagerCustomMessage(message)) {
    sessionManager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      message.details,
    );
    return;
  }

  if (isSessionManagerMessage(message)) {
    sessionManager.appendMessage(message);
  }
}

function isSessionManagerCustomMessage(
  message: AgentMessage,
): message is SessionManagerCustomMessage {
  return message.role === "custom";
}

function isSessionManagerMessage(message: AgentMessage): message is SessionManagerMessage {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult" ||
    message.role === "custom" ||
    message.role === "bashExecution"
  );
}

function setSessionManagerInternals(
  sessionManager: SessionManager,
  internals: SessionManagerInternals,
): void {
  Object.assign(sessionManager, {
    fileEntries: internals.fileEntries,
    byId: internals.byId,
    labelsById: internals.labelsById,
    labelTimestampsById: internals.labelTimestampsById,
    leafId: internals.leafId,
  });
}
