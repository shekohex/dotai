import type {
  ExtensionUiRequestEventPayload,
  SessionSnapshot,
  SessionSyncEvent,
  StreamEventEnvelope,
} from "../../schemas.js";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { JsonValue } from "../../json-schema.js";
import { readRemoteExtensionSyncInfo } from "../../session-sync-metadata.js";
import { fromTransportTranscript } from "../../transcript-transport.js";

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
  for (const durableExtensionEvent of input.extensionState) {
    const syncInfo = readRemoteExtensionSyncInfo(
      durableExtensionEvent.channel,
      durableExtensionEvent.data,
    );
    const key = syncInfo.stateKey;
    const serialized = JSON.stringify(durableExtensionEvent.data);
    nextApplied.set(key, serialized);
    if (input.appliedSnapshotExtensionState.get(key) === serialized) {
      continue;
    }
    input.emit(durableExtensionEvent.channel, durableExtensionEvent.data);
  }
  input.appliedSnapshotExtensionState.clear();
  for (const [key, value] of nextApplied) {
    input.appliedSnapshotExtensionState.set(key, value);
  }
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
  sessionId: string;
  streamOffset: string;
  patch: Extract<SessionSyncEvent, { type: "patch" }>["patch"];
  handleEnvelope: (envelope: StreamEventEnvelope) => Promise<void>;
  handleAgentSessionEvent: (event: AgentSessionEvent) => void;
  emitExtensionCustom: (channel: string, data: JsonValue) => void;
  handleUiRequest: (request: ExtensionUiRequestEventPayload) => Promise<void>;
  cancelUiRequest: (requestId: string) => void;
}): Promise<void> {
  switch (input.patch.patchType) {
    case "session.state":
      await input.handleEnvelope({
        eventId: "sync-patch",
        sessionId: input.sessionId,
        streamOffset: input.streamOffset,
        ts: Date.now(),
        kind: "session_state_patch",
        payload: input.patch.payload,
      });
      return;
    case "assistant.message":
      await input.handleEnvelope(
        toAssistantMessageUpdateEnvelope(input.sessionId, input.streamOffset, input.patch),
      );
      return;
    case "tool.execution":
      input.handleAgentSessionEvent(input.patch.payload);
      return;
    case "queue.update":
      input.handleAgentSessionEvent(input.patch.payload);
      return;
    case "retry.status":
      input.handleAgentSessionEvent(input.patch.payload);
      return;
    case "compaction.status":
      await input.handleEnvelope({
        eventId: "sync-patch",
        sessionId: input.sessionId,
        streamOffset: input.streamOffset,
        ts: Date.now(),
        kind: "agent_session_event",
        payload: input.patch.payload,
      });
      return;
    case "agent.lifecycle":
      await input.handleEnvelope({
        eventId: "sync-patch",
        sessionId: input.sessionId,
        streamOffset: input.streamOffset,
        ts: Date.now(),
        kind: "agent_session_event",
        payload: input.patch.payload,
      });
      return;
    case "extension.custom":
      input.emitExtensionCustom(input.patch.payload.channel, input.patch.payload.data);
      return;
    case "extension.event":
      await input.handleEnvelope({
        eventId: "sync-patch",
        sessionId: input.sessionId,
        streamOffset: input.streamOffset,
        ts: Date.now(),
        kind: "extension_event",
        payload: input.patch.payload,
      });
      return;
    case "extension.ui.request":
      await input.handleUiRequest(input.patch.payload);
      return;
    case "extension.ui.resolved":
      input.cancelUiRequest(input.patch.payload.id);
      return;
    case "command.accepted":
      await input.handleEnvelope({
        eventId: "sync-patch",
        sessionId: input.sessionId,
        streamOffset: input.streamOffset,
        ts: Date.now(),
        kind: "command_accepted",
        payload: input.patch.payload,
      });
      return;
    case "bash.start":
    case "bash.chunk":
    case "bash.end":
    case "bash.flush":
    case "extension.error":
      await input.handleEnvelope(
        createSyntheticSyncEnvelope(input.sessionId, input.streamOffset, input.patch),
      );
      break;
  }
}

function createSyntheticSyncEnvelope(
  sessionId: string,
  streamOffset: string,
  patch: Extract<SessionSyncEvent, { type: "patch" }>["patch"],
): StreamEventEnvelope {
  const base = { eventId: "sync-patch", sessionId, streamOffset, ts: Date.now() };
  switch (patch.patchType) {
    case "assistant.message":
    case "tool.execution":
    case "queue.update":
    case "retry.status":
    case "compaction.status":
    case "agent.lifecycle":
    case "command.accepted":
    case "extension.custom":
    case "extension.event":
    case "extension.ui.request":
    case "extension.ui.resolved":
    case "session.state":
      throw new Error("Unsupported synthetic sync patch");
    case "bash.start":
      return { ...base, kind: "bash_start", payload: patch.payload };
    case "bash.chunk":
      return { ...base, kind: "bash_chunk", payload: patch.payload };
    case "bash.end":
      return { ...base, kind: "bash_end", payload: patch.payload };
    case "bash.flush":
      return { ...base, kind: "bash_flush", payload: patch.payload };
    case "extension.error":
      return { ...base, kind: "extension_error", payload: patch.payload };
    default:
      throw new Error("Unsupported synthetic sync patch");
  }
}

function toAssistantMessageUpdateEnvelope(
  sessionId: string,
  streamOffset: string,
  patch: Extract<
    Extract<SessionSyncEvent, { type: "patch" }>["patch"],
    { patchType: "assistant.message" }
  >,
): Extract<StreamEventEnvelope, { kind: "agent_session_event" }> {
  return {
    eventId: "sync-patch",
    sessionId,
    streamOffset,
    ts: Date.now(),
    kind: "agent_session_event",
    payload: {
      type: "message_update",
      message: patch.payload.message,
      assistantMessageEvent: patch.payload.assistantMessageEvent,
    },
  };
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
