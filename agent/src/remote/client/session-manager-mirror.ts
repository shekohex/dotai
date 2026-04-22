import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentSessionEvent, SessionManager } from "@mariozechner/pi-coding-agent";

type SessionManagerMessage = Parameters<SessionManager["appendMessage"]>[0];
type SessionManagerCustomMessage = Extract<AgentMessage, { role: "custom" }>;

export function initializeMirroredSessionManager(input: {
  sessionManager: SessionManager;
  sessionId: string;
  sessionName: string;
  messages: AgentMessage[];
}): void {
  input.sessionManager.newSession({ id: input.sessionId });
  input.sessionManager.appendSessionInfo(input.sessionName);
  appendMessages(input.sessionManager, input.messages);
}

export function rehydrateMirroredSessionManager(input: {
  sessionManager: SessionManager;
  sessionId: string;
  sessionName?: string;
  messages: AgentMessage[];
}): void {
  input.sessionManager.newSession({ id: input.sessionId });
  if (input.sessionName !== undefined && input.sessionName.length > 0) {
    input.sessionManager.appendSessionInfo(input.sessionName);
  }
  appendMessages(input.sessionManager, input.messages);
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

function appendMessages(sessionManager: SessionManager, messages: AgentMessage[]): void {
  for (const message of messages) {
    appendSessionManagerMessage(sessionManager, message);
  }
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
