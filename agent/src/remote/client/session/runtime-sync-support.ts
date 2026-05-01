import type {
  ExtensionUiRequestEventPayload,
  SessionSnapshot,
  SessionSyncEvent,
} from "../../schemas.js";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { JsonValue } from "../../json-schema.js";
import { JsonValueSchema } from "../../json-schema.js";
import { createDurableExtensionRemovalEvent } from "../../session/durable-runtime-state.js";
import { readRemoteExtensionSyncInfo } from "../../session-sync-metadata.js";
import { fromTransportTranscript } from "../../transcript-transport.js";
import type { ForwardableRemoteExtensionEvent } from "./local-extension-runner.js";

const AppliedSnapshotExtensionStateSchema = Type.Object({
  channel: Type.String(),
  data: JsonValueSchema,
});

type ImmediateUiRequest = Extract<
  ExtensionUiRequestEventPayload,
  | { method: "setStatus" }
  | { method: "setWidget" }
  | { method: "setWorkingMessage" }
  | { method: "setHiddenThinkingLabel" }
  | { method: "setTitle" }
  | { method: "setToolsExpanded" }
  | { method: "set_editor_text" }
>;

export function readSnapshotLiveState(snapshot: SessionSnapshot): SessionSnapshot["live"] {
  return (
    snapshot.live ?? {
      queuedSteeringMessages: [],
      queuedFollowUpMessages: [],
      retryAttempt: 0,
      activeToolExecutions: [],
    }
  );
}

export function replaySnapshotUiState(input: {
  pendingUiRequests: SessionSnapshot["pendingUiRequests"];
  uiState: SessionSnapshot["uiState"];
  applyImmediateUiState: (request: ImmediateUiRequest) => void;
  replaceBufferedUiRequests: (requests: ExtensionUiRequestEventPayload[]) => void;
}): void {
  for (const status of input.uiState.statuses) {
    input.applyImmediateUiState({
      id: `snapshot-status-${status.statusKey}`,
      method: "setStatus",
      statusKey: status.statusKey,
      ...(status.statusText === undefined ? {} : { statusText: status.statusText }),
    });
  }
  for (const widget of input.uiState.widgets) {
    input.applyImmediateUiState({
      id: `snapshot-widget-${widget.widgetKey}`,
      method: "setWidget",
      widgetKey: widget.widgetKey,
      ...(widget.widgetLines === undefined ? {} : { widgetLines: widget.widgetLines }),
      ...(widget.widgetPlacement === undefined ? {} : { widgetPlacement: widget.widgetPlacement }),
    });
  }
  if (input.uiState.workingMessage !== undefined) {
    input.applyImmediateUiState({
      id: "snapshot-working-message",
      method: "setWorkingMessage",
      message: input.uiState.workingMessage,
    });
  }
  if (input.uiState.hiddenThinkingLabel !== undefined) {
    input.applyImmediateUiState({
      id: "snapshot-hidden-thinking-label",
      method: "setHiddenThinkingLabel",
      label: input.uiState.hiddenThinkingLabel,
    });
  }
  if (input.uiState.title !== undefined) {
    input.applyImmediateUiState({
      id: "snapshot-title",
      method: "setTitle",
      title: input.uiState.title,
    });
  }
  if (input.uiState.toolsExpanded !== undefined) {
    input.applyImmediateUiState({
      id: "snapshot-tools-expanded",
      method: "setToolsExpanded",
      expanded: input.uiState.toolsExpanded,
    });
  }
  if (input.uiState.editorText !== undefined) {
    input.applyImmediateUiState({
      id: "snapshot-editor-text",
      method: "set_editor_text",
      text: input.uiState.editorText,
    });
  }
  input.replaceBufferedUiRequests(
    input.pendingUiRequests.map((request) => structuredClone(request)),
  );
}

export function replaySnapshotExtensionState(input: {
  extensionState: Array<{ channel: string; data: JsonValue }>;
  appliedSnapshotExtensionState: Map<string, string>;
  emit: (channel: string, data: JsonValue) => void;
}): void {
  const nextApplied = new Map<string, string>();
  const previousApplied = new Map(input.appliedSnapshotExtensionState);
  for (const durableExtensionEvent of input.extensionState) {
    const syncInfo = readRemoteExtensionSyncInfo(
      durableExtensionEvent.channel,
      durableExtensionEvent.data,
    );
    const key = syncInfo.stateKey;
    const serialized = serializeAppliedSnapshotExtensionState(
      durableExtensionEvent.channel,
      durableExtensionEvent.data,
    );
    nextApplied.set(key, serialized);
    if (input.appliedSnapshotExtensionState.get(key) === serialized) {
      continue;
    }
    input.emit(durableExtensionEvent.channel, durableExtensionEvent.data);
  }
  for (const [staleKey, staleValue] of previousApplied) {
    if (nextApplied.has(staleKey)) {
      continue;
    }
    const previousState = parseAppliedSnapshotExtensionState(staleValue);
    if (previousState === undefined) {
      continue;
    }
    const syncInfo = readRemoteExtensionSyncInfo(previousState.channel, previousState.data);
    const removalEvent = createDurableExtensionRemovalEvent({
      channel: previousState.channel,
      replaceKey: syncInfo.replaceKey,
    });
    input.emit(removalEvent.channel, removalEvent.data);
  }
  input.appliedSnapshotExtensionState.clear();
  for (const [key, value] of nextApplied) {
    input.appliedSnapshotExtensionState.set(key, value);
  }
}

function serializeAppliedSnapshotExtensionState(channel: string, data: JsonValue): string {
  return JSON.stringify({ channel, data });
}

function parseAppliedSnapshotExtensionState(
  value: string,
): { channel: string; data: JsonValue } | undefined {
  const parsed: unknown = JSON.parse(value);
  if (!Value.Check(AppliedSnapshotExtensionStateSchema, parsed)) {
    return undefined;
  }

  return Value.Parse(AppliedSnapshotExtensionStateSchema, parsed);
}

export function replaySnapshotLiveOverlay(input: {
  snapshot: SessionSnapshot;
  forwardAgentSessionEventToLocalExtensions: (event: AgentSessionEvent) => void;
}): void {
  const liveState = readSnapshotLiveState(input.snapshot);
  if (liveState.streamingMessage !== undefined) {
    const streamingMessage = fromTransportTranscript([liveState.streamingMessage])[0];
    const assistantMessage = toAssistantSessionMessage(streamingMessage);
    if (assistantMessage !== undefined) {
      input.forwardAgentSessionEventToLocalExtensions({
        type: "message_start",
        message: assistantMessage,
      });
      input.forwardAgentSessionEventToLocalExtensions({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: {
          type: "start",
          partial: assistantMessage,
        },
      });
    }
  }

  for (const execution of liveState.activeToolExecutions) {
    input.forwardAgentSessionEventToLocalExtensions({
      type: "tool_execution_start",
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      args: execution.args,
    });
    if (execution.partialResult !== undefined) {
      input.forwardAgentSessionEventToLocalExtensions({
        type: "tool_execution_update",
        toolCallId: execution.toolCallId,
        toolName: execution.toolName,
        args: execution.args,
        partialResult: execution.partialResult,
      });
    }
  }
}

export async function applySessionSyncPatch(input: {
  patch: Extract<SessionSyncEvent, { type: "patch" }>["patch"];
  handleAgentSessionEvent: (event: AgentSessionEvent) => void;
  handleAssistantMessagePatch: (
    payload: Extract<
      Extract<SessionSyncEvent, { type: "patch" }>["patch"],
      { patchType: "assistant.message" }
    >["payload"],
  ) => void;
  handleToolExecutionPatch: (
    payload: Extract<
      Extract<SessionSyncEvent, { type: "patch" }>["patch"],
      { patchType: "tool.execution" }
    >["payload"],
  ) => void;
  applySessionStatePatch: (
    payload: Extract<
      Extract<SessionSyncEvent, { type: "patch" }>["patch"],
      { patchType: "session.state" }
    >["payload"],
  ) => void;
  handleExtensionEvent: (event: ForwardableRemoteExtensionEvent) => void;
  isForwardableRemoteExtensionEvent: (value: unknown) => value is ForwardableRemoteExtensionEvent;
  emitExtensionCustom: (channel: string, data: JsonValue) => void;
  handleUiRequest: (request: ExtensionUiRequestEventPayload) => Promise<void>;
  cancelUiRequest: (requestId: string) => void;
  handleExtensionError: (error: string) => void;
  handleBashStart: (
    payload: Extract<
      Extract<SessionSyncEvent, { type: "patch" }>["patch"],
      { patchType: "bash.start" }
    >["payload"],
  ) => void;
  handleBashChunk: (
    payload: Extract<
      Extract<SessionSyncEvent, { type: "patch" }>["patch"],
      { patchType: "bash.chunk" }
    >["payload"],
  ) => void;
  handleBashEnd: (
    payload: Extract<
      Extract<SessionSyncEvent, { type: "patch" }>["patch"],
      { patchType: "bash.end" }
    >["payload"],
  ) => void;
  handleBashFlush: (
    payload: Extract<
      Extract<SessionSyncEvent, { type: "patch" }>["patch"],
      { patchType: "bash.flush" }
    >["payload"],
  ) => void;
}): Promise<void> {
  switch (input.patch.patchType) {
    case "session.state":
      input.applySessionStatePatch(input.patch.payload);
      return;
    case "assistant.message":
      input.handleAssistantMessagePatch(input.patch.payload);
      return;
    case "tool.execution":
      input.handleToolExecutionPatch(input.patch.payload);
      return;
    case "queue.update":
      input.handleAgentSessionEvent(input.patch.payload);
      return;
    case "retry.status":
      input.handleAgentSessionEvent(input.patch.payload);
      return;
    case "compaction.status":
      input.handleAgentSessionEvent(toCompactionStatusEvent(input.patch.payload));
      return;
    case "agent.lifecycle":
      input.handleAgentSessionEvent(toAgentLifecycleEvent(input.patch.payload));
      return;
    case "extension.custom":
      input.emitExtensionCustom(input.patch.payload.channel, input.patch.payload.data);
      return;
    case "extension.event":
      if (input.isForwardableRemoteExtensionEvent(input.patch.payload)) {
        input.handleExtensionEvent(input.patch.payload);
      }
      return;
    case "extension.ui.request":
      await input.handleUiRequest(input.patch.payload);
      return;
    case "extension.ui.resolved":
      input.cancelUiRequest(input.patch.payload.id);
      return;
    case "command.accepted":
      return;
    case "bash.start":
      input.handleBashStart(input.patch.payload);
      return;
    case "bash.chunk":
      input.handleBashChunk(input.patch.payload);
      return;
    case "bash.end":
      input.handleBashEnd(input.patch.payload);
      return;
    case "bash.flush":
      input.handleBashFlush(input.patch.payload);
      return;
    case "extension.error":
      input.handleExtensionError(input.patch.payload.error);
      break;
  }
}

export function toAssistantMessagePatchEvent(
  payload: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "assistant.message" }
  >["payload"],
  currentStreamingMessage?: AssistantMessage,
): AgentSessionEvent {
  if (payload.assistantMessageEvent.type === "done") {
    return {
      type: "message_update",
      message: payload.assistantMessageEvent.message,
      assistantMessageEvent: payload.assistantMessageEvent,
    };
  }

  if (payload.assistantMessageEvent.type === "error") {
    return {
      type: "message_update",
      message: payload.assistantMessageEvent.error,
      assistantMessageEvent: payload.assistantMessageEvent,
    };
  }

  if (payload.assistantMessageEvent.type === "start") {
    return {
      type: "message_update",
      message: payload.assistantMessageEvent.partial,
      assistantMessageEvent: payload.assistantMessageEvent,
    };
  }

  const nextMessage = applyAssistantMessageSyncEvent(
    currentStreamingMessage,
    payload.assistantMessageEvent,
  );
  return {
    type: "message_update",
    message: nextMessage,
    assistantMessageEvent: {
      ...payload.assistantMessageEvent,
      partial: nextMessage,
    },
  } as AgentSessionEvent;
}

function applyAssistantMessageSyncEvent(
  currentStreamingMessage: AssistantMessage | undefined,
  event: Exclude<
    Extract<
      Extract<SessionSyncEvent, { type: "patch" }>["patch"],
      { patchType: "assistant.message" }
    >["payload"]["assistantMessageEvent"],
    { type: "start" } | { type: "done" } | { type: "error" }
  >,
): AssistantMessage {
  if (event.type === "toolcall_start" || event.type === "toolcall_delta") {
    return event.partial;
  }

  const baseMessage = currentStreamingMessage ?? {
    role: "assistant" as const,
    content: [],
    api: "remote",
    provider: "remote",
    model: "remote",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };

  const nextContent = [...baseMessage.content];
  switch (event.type) {
    case "text_start":
      nextContent[event.contentIndex] = { type: "text", text: "" };
      break;
    case "text_delta": {
      const existingBlock = nextContent[event.contentIndex];
      nextContent[event.contentIndex] = {
        type: "text",
        text: existingBlock?.type === "text" ? `${existingBlock.text}${event.delta}` : event.delta,
      };
      break;
    }
    case "text_end":
      nextContent[event.contentIndex] = { type: "text", text: event.content };
      break;
    case "thinking_start":
      nextContent[event.contentIndex] = { type: "thinking", thinking: "" };
      break;
    case "thinking_delta": {
      const existingBlock = nextContent[event.contentIndex];
      nextContent[event.contentIndex] = {
        type: "thinking",
        thinking:
          existingBlock?.type === "thinking"
            ? `${existingBlock.thinking}${event.delta}`
            : event.delta,
      };
      break;
    }
    case "thinking_end":
      nextContent[event.contentIndex] = { type: "thinking", thinking: event.content };
      break;
    case "toolcall_end":
      nextContent[event.contentIndex] = event.toolCall;
      break;
  }

  return {
    ...baseMessage,
    content: nextContent,
  };
}

function toCompactionStatusEvent(
  payload: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "compaction.status" }
  >["payload"],
): AgentSessionEvent {
  if (payload.type === "compaction_start") {
    return {
      type: "compaction_start",
      reason: payload.reason,
    };
  }

  return {
    type: "compaction_end",
    reason: payload.reason,
    result: undefined,
    aborted: payload.aborted,
    willRetry: payload.willRetry,
    ...(payload.errorMessage === undefined ? {} : { errorMessage: payload.errorMessage }),
  };
}

function toAgentLifecycleEvent(
  payload: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "agent.lifecycle" }
  >["payload"],
): AgentSessionEvent {
  switch (payload.type) {
    case "agent_start":
      return { type: "agent_start" };
    case "turn_start":
      return {
        type: "turn_start",
        ...(payload.turnIndex === undefined ? {} : { turnIndex: payload.turnIndex }),
        ...(payload.timestamp === undefined ? {} : { timestamp: payload.timestamp }),
      };
    case "agent_end":
      return {
        type: "agent_end",
        messages: fromTransportTranscript(payload.messages),
      };
    case "turn_end":
      return {
        type: "turn_end",
        ...(payload.turnIndex === undefined ? {} : { turnIndex: payload.turnIndex }),
        message: fromTransportTranscript([payload.message])[0],
        toolResults: fromTransportTranscript(payload.toolResults).filter(
          (
            message,
          ): message is Extract<AgentSessionEvent, { type: "turn_end" }>["toolResults"][number] =>
            message.role === "toolResult",
        ),
      };
    case "message_start":
      return {
        type: "message_start",
        message: fromTransportTranscript([payload.message])[0],
      };
    case "message_end":
      return {
        type: "message_end",
        message: fromTransportTranscript([payload.message])[0],
      };
  }

  throw new Error("Unsupported agent lifecycle patch");
}

function toAssistantSessionMessage(
  message: ReturnType<typeof fromTransportTranscript>[number],
): AssistantMessage | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }

  return {
    role: "assistant",
    content: message.content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    responseId: message.responseId,
    usage: message.usage,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    timestamp: message.timestamp,
  };
}
