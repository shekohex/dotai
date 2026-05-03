import { Value } from "typebox/value";
import { toAssistantMessageSyncEvent } from "./assistant-message-sync.js";
import type { SessionSyncEvent, StreamEventEnvelope } from "./schemas.js";
import { AgentLifecycleEventPayloadSchema } from "./schemas-stream.js";

export function toSessionSyncPatchEvent(
  sessionId: string,
  event: StreamEventEnvelope,
): Extract<SessionSyncEvent, { type: "patch" }> | undefined {
  if (event.sessionVersion === undefined) {
    return undefined;
  }

  const patchBase = {
    type: "patch" as const,
    sessionId,
    version: event.sessionVersion,
  };

  switch (event.kind) {
    case "session_state_patch":
      return { ...patchBase, patch: { patchType: "session.state", payload: event.payload } };
    case "agent_session_event":
      return toAgentSessionSyncPatchEvent(patchBase, event.payload);
    case "assistant_message_patch":
    case "tool_execution_patch":
    case "extension_custom_event":
    case "extension_event":
    case "extension_ui_request":
    case "extension_ui_resolved":
    case "command_accepted":
    case "bash_start":
    case "bash_chunk":
    case "bash_end":
    case "bash_flush":
    case "extension_error":
      return toNonAgentSessionSyncPatchEvent(patchBase, event);
    case "auth_notice":
    case "client_presence_updated":
    case "server_notice":
    case "session_closed":
    case "session_created":
    case "session_summary_updated":
      return undefined;
  }

  return undefined;
}

export function compareSessionVersions(left: string, right: string): number {
  const leftVersion = BigInt(left);
  const rightVersion = BigInt(right);
  if (leftVersion < rightVersion) {
    return -1;
  }
  if (leftVersion > rightVersion) {
    return 1;
  }
  return 0;
}

export function readPatchFingerprint(event: SessionSyncEvent): string | undefined {
  if (event.type !== "patch") {
    return undefined;
  }

  return `${event.version}:${JSON.stringify(event.patch)}`;
}

function toAgentSessionSyncPatchEvent(
  patchBase: Omit<Extract<SessionSyncEvent, { type: "patch" }>, "patch">,
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): Extract<SessionSyncEvent, { type: "patch" }> | undefined {
  if (isAssistantMessageUpdatePayload(payload)) {
    return {
      ...patchBase,
      patch: {
        patchType: "assistant.message",
        payload: {
          type: "message_update",
          assistantMessageEvent: toAssistantMessageSyncEvent(payload.assistantMessageEvent),
        },
      },
    };
  }
  if (isToolExecutionPayload(payload)) {
    return {
      ...patchBase,
      patch: { patchType: "tool.execution", payload: toToolExecutionSyncPayload(payload) },
    };
  }
  if (isQueueUpdatePayload(payload)) {
    return {
      ...patchBase,
      patch: {
        patchType: "queue.update",
        payload: {
          type: "queue_update",
          steering: [...payload.steering],
          followUp: [...payload.followUp],
        },
      },
    };
  }
  if (isRetryStatusPayload(payload)) {
    return { ...patchBase, patch: { patchType: "retry.status", payload } };
  }
  if (isCompactionStatusPayload(payload)) {
    return { ...patchBase, patch: { patchType: "compaction.status", payload } };
  }
  if (isAgentLifecyclePayload(payload)) {
    return { ...patchBase, patch: { patchType: "agent.lifecycle", payload } };
  }
  return undefined;
}

function toNonAgentSessionSyncPatchEvent(
  patchBase: Omit<Extract<SessionSyncEvent, { type: "patch" }>, "patch">,
  event: Exclude<
    StreamEventEnvelope,
    | { kind: "session_state_patch" }
    | { kind: "agent_session_event" }
    | { kind: "auth_notice" }
    | { kind: "client_presence_updated" }
    | { kind: "server_notice" }
    | { kind: "session_closed" }
    | { kind: "session_created" }
    | { kind: "session_summary_updated" }
  >,
): Extract<SessionSyncEvent, { type: "patch" }> {
  switch (event.kind) {
    case "assistant_message_patch":
      return { ...patchBase, patch: { patchType: "assistant.message", payload: event.payload } };
    case "tool_execution_patch":
      return { ...patchBase, patch: { patchType: "tool.execution", payload: event.payload } };
    case "extension_custom_event":
      return { ...patchBase, patch: { patchType: "extension.custom", payload: event.payload } };
    case "extension_event":
      return { ...patchBase, patch: { patchType: "extension.event", payload: event.payload } };
    case "extension_ui_request":
      return { ...patchBase, patch: { patchType: "extension.ui.request", payload: event.payload } };
    case "extension_ui_resolved":
      return {
        ...patchBase,
        patch: { patchType: "extension.ui.resolved", payload: event.payload },
      };
    case "command_accepted":
      return { ...patchBase, patch: { patchType: "command.accepted", payload: event.payload } };
    case "bash_start":
      return { ...patchBase, patch: { patchType: "bash.start", payload: event.payload } };
    case "bash_chunk":
      return { ...patchBase, patch: { patchType: "bash.chunk", payload: event.payload } };
    case "bash_end":
      return { ...patchBase, patch: { patchType: "bash.end", payload: event.payload } };
    case "bash_flush":
      return { ...patchBase, patch: { patchType: "bash.flush", payload: event.payload } };
    case "extension_error":
      return { ...patchBase, patch: { patchType: "extension.error", payload: event.payload } };
  }

  throw new Error("Unsupported non-agent session sync patch event");
}

function toToolExecutionSyncPayload(
  payload: Extract<
    Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
    | { type: "tool_execution_start" }
    | { type: "tool_execution_update" }
    | { type: "tool_execution_end" }
  >,
): Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "tool.execution" }
>["payload"] {
  if (payload.type === "tool_execution_start") {
    return {
      type: "tool_execution_start",
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      args: payload.args,
    };
  }
  if (payload.type === "tool_execution_update") {
    return {
      type: "tool_execution_update",
      toolCallId: payload.toolCallId,
      partialResult: payload.partialResult,
    };
  }
  return {
    type: "tool_execution_end",
    toolCallId: payload.toolCallId,
    result: payload.result,
    isError: payload.isError,
  };
}

function isAssistantMessageUpdatePayload(
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): payload is Extract<
  Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
  { type: "message_update" }
> & { message: { role: "assistant" } } {
  return payload.type === "message_update" && payload.message.role === "assistant";
}

function isToolExecutionPayload(
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): payload is Extract<
  Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
  | { type: "tool_execution_start" }
  | { type: "tool_execution_update" }
  | { type: "tool_execution_end" }
> {
  return (
    payload.type === "tool_execution_start" ||
    payload.type === "tool_execution_update" ||
    payload.type === "tool_execution_end"
  );
}

function isQueueUpdatePayload(
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): payload is Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "queue.update" }
>["payload"] {
  return payload.type === "queue_update";
}

function isRetryStatusPayload(
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): payload is Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "retry.status" }
>["payload"] {
  return payload.type === "auto_retry_start" || payload.type === "auto_retry_end";
}

function isCompactionStatusPayload(
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): payload is Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "compaction.status" }
>["payload"] {
  return payload.type === "compaction_start" || payload.type === "compaction_end";
}

function isAgentLifecyclePayload(
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): payload is Extract<
  Extract<SessionSyncEvent, { type: "patch" }>["patch"],
  { patchType: "agent.lifecycle" }
>["payload"] {
  return Value.Check(AgentLifecycleEventPayloadSchema, payload);
}
