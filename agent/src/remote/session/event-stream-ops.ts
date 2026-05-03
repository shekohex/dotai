import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { toAssistantMessageSyncEvent } from "../assistant-message-sync.js";
import type { SessionLiveEventBus } from "../live-events.js";
import type { JsonValue } from "../json-schema.js";
import { toJsonValue } from "../json-value.js";
import type {
  ExtensionUiRequestEventPayload,
  ExtensionUiResolvedEventPayload,
  SessionSyncEvent,
} from "../schemas.js";
import { toTransportTranscript } from "../transcript-transport.js";
import { diffToolPartialResult, readToolOutputText } from "../tool-output-text.js";
import { persistDurableRuntimeDomainState } from "./durable-runtime-state.js";
import { handleSessionEventForRecord } from "./event-ops.js";
import { hasExtensionMetadataChange } from "./helpers.js";
import type { SessionRecord } from "./types.js";

type SessionSyncPatchEvent = Extract<SessionSyncEvent, { type: "patch" }>;

function publishSessionSyncPatch(
  liveEvents: SessionLiveEventBus | undefined,
  event: SessionSyncPatchEvent,
): void {
  liveEvents?.publishSessionSyncEvent(event.sessionId, event);
}

export function emitSessionSummaryUpdatedEvent(input: {
  liveEvents?: SessionLiveEventBus;
  record: SessionRecord;
  ts: number;
}): void {
  void input.liveEvents;
  void input.record;
  void input.ts;
}

export function appendExtensionUiRequestEvent(input: {
  liveEvents?: SessionLiveEventBus;
  record: SessionRecord;
  payload: ExtensionUiRequestEventPayload;
  ts: number;
}): void {
  void input.ts;
  publishSessionSyncPatch(input.liveEvents, {
    type: "patch",
    sessionId: input.record.sessionId,
    version: String(input.record.lastDurableSessionVersion),
    patch: { patchType: "extension.ui.request", payload: input.payload },
  });
}

export function appendExtensionUiResolvedEvent(input: {
  liveEvents?: SessionLiveEventBus;
  record: SessionRecord;
  payload: ExtensionUiResolvedEventPayload;
  ts: number;
}): void {
  void input.ts;
  publishSessionSyncPatch(input.liveEvents, {
    type: "patch",
    sessionId: input.record.sessionId,
    version: String(input.record.lastDurableSessionVersion),
    patch: { patchType: "extension.ui.resolved", payload: input.payload },
  });
}

export function handleRegistrySessionEvent(input: {
  sessionId: string;
  event: AgentSessionEvent;
  sessions: Map<string, SessionRecord>;
  liveEvents?: SessionLiveEventBus;
  now: number;
  createRunId: () => string;
  syncFromRuntime: (
    record: SessionRecord,
    options: { now: number; updateTimestamp: boolean },
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): void {
  const record = input.sessions.get(input.sessionId);
  if (!record) {
    return;
  }

  const durableRuntimeStateChanged = handleSessionEventForRecord({
    record,
    event: input.event,
    now: input.now,
    createRunId: input.createRunId,
    syncFromRuntime: input.syncFromRuntime,
    hasExtensionMetadataChange,
    appendAgentEvent: createAppendAgentEvent(input.liveEvents),
    appendSessionStatePatch: (targetRecord, sessionVersion, patch) => {
      publishSessionSyncPatch(input.liveEvents, {
        type: "patch",
        sessionId: targetRecord.sessionId,
        version: sessionVersion,
        patch: {
          patchType: "session.state",
          payload: {
            commandId: "server-state-sync",
            sequence: targetRecord.queue.nextSequence,
            patch,
          },
        },
      });
    },
    emitSessionSummaryUpdated: input.emitSessionSummaryUpdated,
  });

  if (!durableRuntimeStateChanged) {
    return;
  }

  record.lastDurableSessionVersion += 1;
  persistDurableRuntimeDomainState({
    record,
    updatedAt: input.now,
  });
}

function createAppendAgentEvent(liveEvents: SessionLiveEventBus | undefined) {
  return (
    targetRecord: SessionRecord,
    targetEvent: AgentSessionEvent,
    _ts: number,
    sessionVersion: string,
    previousLiveState: SessionRecord["live"],
  ): void => {
    const patchEvent = toAgentSyncPatchEvent(
      targetRecord.sessionId,
      sessionVersion,
      targetEvent,
      previousLiveState,
    );
    if (patchEvent === undefined) {
      return;
    }

    publishSessionSyncPatch(liveEvents, patchEvent);
  };
}

function toAgentSyncPatchEvent(
  sessionId: string,
  version: string,
  event: AgentSessionEvent,
  previousLiveState: SessionRecord["live"],
): SessionSyncPatchEvent | undefined {
  const patch =
    toAssistantMessagePatch(event) ??
    toToolExecutionPatch(event, previousLiveState) ??
    toAgentLifecyclePatch(event) ??
    toQueuePatch(event) ??
    toRetryPatch(event) ??
    toCompactionPatch(event);

  if (patch === undefined) {
    return undefined;
  }

  return {
    type: "patch",
    sessionId,
    version,
    patch,
  };
}

function toAssistantMessagePatch(
  event: AgentSessionEvent,
): SessionSyncPatchEvent["patch"] | undefined {
  if (event.type !== "message_update" || event.message.role !== "assistant") {
    return undefined;
  }

  return {
    patchType: "assistant.message",
    payload: {
      type: "message_update",
      assistantMessageEvent: toAssistantMessageSyncEvent(event.assistantMessageEvent),
    },
  };
}

function toToolExecutionPatch(
  event: AgentSessionEvent,
  previousLiveState: SessionRecord["live"],
): SessionSyncPatchEvent["patch"] | undefined {
  if (event.type === "tool_execution_start") {
    return {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: toJsonValue(event.args) ?? null,
      },
    };
  }

  if (event.type === "tool_execution_update") {
    const activeExecution = previousLiveState.activeToolExecutions.get(event.toolCallId);
    const nextPartialResult = toJsonValue(event.partialResult) ?? null;
    const outputDelta = readToolPartialOutputDelta(
      activeExecution?.partialResult,
      nextPartialResult,
    );
    if (outputDelta !== undefined) {
      return {
        patchType: "tool.execution",
        payload: {
          type: "tool_execution_output_delta",
          toolCallId: event.toolCallId,
          start: outputDelta.start,
          delta: outputDelta.delta,
        },
      };
    }

    const partialPatchOperations = diffToolPartialResult(
      activeExecution?.partialResult,
      nextPartialResult,
    );
    if (partialPatchOperations !== undefined) {
      return {
        patchType: "tool.execution",
        payload: {
          type: "tool_execution_partial_patch",
          toolCallId: event.toolCallId,
          ops: partialPatchOperations,
        },
      };
    }

    return {
      patchType: "tool.execution",
      payload: {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        partialResult: nextPartialResult,
      },
    };
  }

  if (event.type !== "tool_execution_end") {
    return undefined;
  }

  return {
    patchType: "tool.execution",
    payload: {
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      result: toJsonValue(event.result) ?? null,
      isError: event.isError,
    },
  };
}

function toAgentLifecyclePatch(
  event: AgentSessionEvent,
): SessionSyncPatchEvent["patch"] | undefined {
  switch (event.type) {
    case "agent_start":
      return { patchType: "agent.lifecycle", payload: event };
    case "turn_start":
      return { patchType: "agent.lifecycle", payload: { type: "turn_start" } };
    case "agent_end":
      return {
        patchType: "agent.lifecycle",
        payload: {
          type: "agent_end",
          messages: toTransportTranscript(event.messages),
        },
      };
    case "turn_end":
      return {
        patchType: "agent.lifecycle",
        payload: {
          type: "turn_end",
          message: toTransportTranscript([event.message])[0],
          toolResults: toTransportTranscript(event.toolResults),
        },
      };
    case "message_start":
      return {
        patchType: "agent.lifecycle",
        payload: {
          type: "message_start",
          message: toTransportTranscript([event.message])[0],
        },
      };
    case "message_end":
      return {
        patchType: "agent.lifecycle",
        payload: {
          type: "message_end",
          message: toTransportTranscript([event.message])[0],
        },
      };
    case "message_update":
    case "queue_update":
    case "auto_retry_start":
    case "auto_retry_end":
    case "compaction_start":
    case "compaction_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return undefined;
  }

  return undefined;
}

function toQueuePatch(event: AgentSessionEvent): SessionSyncPatchEvent["patch"] | undefined {
  if (event.type !== "queue_update") {
    return undefined;
  }

  return {
    patchType: "queue.update",
    payload: {
      type: "queue_update",
      steering: [...event.steering],
      followUp: [...event.followUp],
    },
  };
}

function toRetryPatch(event: AgentSessionEvent): SessionSyncPatchEvent["patch"] | undefined {
  if (event.type !== "auto_retry_start" && event.type !== "auto_retry_end") {
    return undefined;
  }

  return {
    patchType: "retry.status",
    payload: event,
  };
}

function toCompactionPatch(event: AgentSessionEvent): SessionSyncPatchEvent["patch"] | undefined {
  if (event.type !== "compaction_start" && event.type !== "compaction_end") {
    return undefined;
  }

  if (event.type === "compaction_start") {
    return {
      patchType: "compaction.status",
      payload: {
        type: "compaction_start",
        reason: event.reason,
      },
    };
  }

  return {
    patchType: "compaction.status",
    payload: {
      type: "compaction_end",
      reason: event.reason,
      aborted: event.aborted,
      willRetry: event.willRetry,
      ...(event.result === undefined ? {} : { result: toJsonValue(event.result) ?? null }),
      ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
    },
  };
}

function readToolPartialOutputDelta(
  previous: JsonValue | undefined,
  next: JsonValue,
): { start: number; delta: string } | undefined {
  const previousText = readToolOutputText(previous);
  const nextText = readToolOutputText(next);
  if (previousText === undefined || nextText === undefined || !nextText.startsWith(previousText)) {
    return undefined;
  }

  if (nextText.length === previousText.length) {
    return undefined;
  }

  return {
    start: previousText.length,
    delta: nextText.slice(previousText.length),
  };
}
