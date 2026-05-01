import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { toAssistantMessageSyncEvent } from "../assistant-message-sync.js";
import type { JsonValue } from "../json-schema.js";
import { toJsonValue } from "../json-value.js";
import { toTransportTranscript } from "../transcript-transport.js";
import { readToolOutputText } from "../tool-output-text.js";
import type { SessionLiveEventBus } from "../live-events.js";
import {
  appEventsStreamId,
  appendAndPublish,
  appendLiveOnlyAndPublish,
  sessionEventsStreamId,
  type InMemoryDurableStreamStore,
} from "../streams.js";
import type {
  ExtensionUiRequestEventPayload,
  ExtensionUiResolvedEventPayload,
  SessionSyncEvent,
  StreamEventEnvelope,
} from "../schemas.js";
import { hasExtensionMetadataChange } from "./helpers.js";
import { persistDurableRuntimeDomainState } from "./durable-runtime-state.js";
import { handleSessionEventForRecord } from "./event-ops.js";
import type { SessionRecord } from "./types.js";

export function emitSessionSummaryUpdatedEvent(input: {
  streams: InMemoryDurableStreamStore;
  liveEvents?: SessionLiveEventBus;
  record: SessionRecord;
  ts: number;
}): void {
  const event = appendAndPublish(input.streams, input.liveEvents, appEventsStreamId(), {
    sessionId: input.record.sessionId,
    kind: "session_summary_updated",
    payload: {
      sessionId: input.record.sessionId,
      sessionName: input.record.sessionName,
      status: input.record.status,
      updatedAt: input.record.updatedAt,
    },
    ts: input.ts,
  });
  input.record.lastAppStreamOffsetSeenByServer = event.streamOffset;
}

export function appendExtensionUiRequestEvent(input: {
  streams: InMemoryDurableStreamStore;
  liveEvents?: SessionLiveEventBus;
  record: SessionRecord;
  payload: ExtensionUiRequestEventPayload;
  ts: number;
}): void {
  appendAndPublish(input.streams, input.liveEvents, sessionEventsStreamId(input.record.sessionId), {
    sessionId: input.record.sessionId,
    kind: "extension_ui_request",
    sessionVersion: String(input.record.lastDurableSessionVersion),
    payload: input.payload,
    ts: input.ts,
  });
}

export function appendExtensionUiResolvedEvent(input: {
  streams: InMemoryDurableStreamStore;
  liveEvents?: SessionLiveEventBus;
  record: SessionRecord;
  payload: ExtensionUiResolvedEventPayload;
  ts: number;
}): void {
  appendAndPublish(input.streams, input.liveEvents, sessionEventsStreamId(input.record.sessionId), {
    sessionId: input.record.sessionId,
    kind: "extension_ui_resolved",
    sessionVersion: String(input.record.lastDurableSessionVersion),
    payload: input.payload,
    ts: input.ts,
  });
}

export function handleRegistrySessionEvent(input: {
  sessionId: string;
  event: AgentSessionEvent;
  sessions: Map<string, SessionRecord>;
  streams: InMemoryDurableStreamStore;
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
    appendAgentEvent: (targetRecord, targetEvent, ts, sessionVersion, previousLiveState) => {
      const streamId = sessionEventsStreamId(targetRecord.sessionId);
      const append = isLiveOnlyAgentSessionEvent(targetEvent)
        ? appendLiveOnlyAndPublish
        : appendAndPublish;
      const livePatchEvent = toLivePatchStreamEvent(
        targetRecord.sessionId,
        targetEvent,
        sessionVersion,
        ts,
        previousLiveState,
      );
      const knownAgentEvent =
        livePatchEvent === undefined
          ? toKnownAgentSessionStreamEvent(targetRecord.sessionId, targetEvent, sessionVersion, ts)
          : undefined;
      if (
        targetEvent.type === "message_update" &&
        targetEvent.message.role === "assistant" &&
        livePatchEvent === undefined
      ) {
        return;
      }
      if (livePatchEvent === undefined && knownAgentEvent === undefined) {
        return;
      }
      const eventToAppend = livePatchEvent ?? knownAgentEvent;
      if (eventToAppend === undefined) {
        return;
      }
      append(input.streams, input.liveEvents, streamId, eventToAppend);
    },
    appendSessionStatePatch: (targetRecord, sessionVersion, patch, ts) => {
      appendAndPublish(
        input.streams,
        input.liveEvents,
        sessionEventsStreamId(targetRecord.sessionId),
        {
          sessionId: targetRecord.sessionId,
          kind: "session_state_patch",
          sessionVersion,
          payload: {
            commandId: "server-state-sync",
            sequence: targetRecord.queue.nextSequence,
            patch,
          },
          ts,
        },
      );
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

function toKnownAgentSessionStreamEvent(
  sessionId: string,
  event: AgentSessionEvent,
  sessionVersion: string,
  ts: number,
):
  | {
      sessionId: string;
      kind: "agent_session_event";
      sessionVersion: string;
      payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"];
      ts: number;
    }
  | undefined {
  switch (event.type) {
    case "agent_start":
      return {
        sessionId,
        kind: "agent_session_event",
        sessionVersion,
        payload: event,
        ts,
      };
    case "turn_start":
      return {
        sessionId,
        kind: "agent_session_event",
        sessionVersion,
        payload: { type: "turn_start" },
        ts,
      };
    case "queue_update":
      return {
        sessionId,
        kind: "agent_session_event",
        sessionVersion,
        payload: {
          type: "queue_update",
          steering: [...event.steering],
          followUp: [...event.followUp],
        },
        ts,
      };
    case "auto_retry_start":
      return {
        sessionId,
        kind: "agent_session_event",
        sessionVersion,
        payload: {
          type: "auto_retry_start",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        },
        ts,
      };
    case "auto_retry_end":
      return {
        sessionId,
        kind: "agent_session_event",
        sessionVersion,
        payload: {
          type: "auto_retry_end",
          success: event.success,
          attempt: event.attempt,
          ...(event.finalError === undefined ? {} : { finalError: event.finalError }),
        },
        ts,
      };
    case "compaction_start":
      return {
        sessionId,
        kind: "agent_session_event",
        sessionVersion,
        payload: {
          type: "compaction_start",
          reason: event.reason,
        },
        ts,
      };
    case "compaction_end":
      return {
        sessionId,
        kind: "agent_session_event",
        sessionVersion,
        payload: {
          type: "compaction_end",
          reason: event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          ...(event.result === undefined ? {} : { result: toJsonValue(event.result) ?? null }),
          ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
        },
        ts,
      };
    case "agent_end":
      return buildKnownAgentSessionStreamEvent(sessionId, sessionVersion, ts, {
        type: "agent_end",
        messages: toTransportTranscript(event.messages),
      });
    case "turn_end":
      return buildKnownAgentSessionStreamEvent(sessionId, sessionVersion, ts, {
        type: "turn_end",
        message: toTransportTranscript([event.message])[0],
        toolResults: toTransportTranscript(event.toolResults),
      });
    case "message_start":
      return buildKnownAgentSessionStreamEvent(sessionId, sessionVersion, ts, {
        type: "message_start",
        message: toTransportTranscript([event.message])[0],
      });
    case "message_end":
      return buildKnownAgentSessionStreamEvent(sessionId, sessionVersion, ts, {
        type: "message_end",
        message: toTransportTranscript([event.message])[0],
      });
    case "message_update":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return undefined;
  }

  return undefined;
}

function buildKnownAgentSessionStreamEvent(
  sessionId: string,
  sessionVersion: string,
  ts: number,
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
): {
  sessionId: string;
  kind: "agent_session_event";
  sessionVersion: string;
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"];
  ts: number;
} {
  return {
    sessionId,
    kind: "agent_session_event",
    sessionVersion,
    payload,
    ts,
  };
}

function isLiveOnlyAgentSessionEvent(event: AgentSessionEvent): boolean {
  return (
    (event.type === "message_update" && event.message.role === "assistant") ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  );
}

function toLivePatchStreamEvent(
  sessionId: string,
  event: AgentSessionEvent,
  sessionVersion: string,
  ts: number,
  previousLiveState: SessionRecord["live"],
):
  | {
      sessionId: string;
      kind: "assistant_message_patch";
      sessionVersion: string;
      payload: Extract<
        Extract<SessionSyncEvent, { type: "patch" }>["patch"],
        { patchType: "assistant.message" }
      >["payload"];
      ts: number;
    }
  | {
      sessionId: string;
      kind: "tool_execution_patch";
      sessionVersion: string;
      payload: Extract<
        Extract<SessionSyncEvent, { type: "patch" }>["patch"],
        { patchType: "tool.execution" }
      >["payload"];
      ts: number;
    }
  | undefined {
  if (event.type === "message_update" && event.message.role === "assistant") {
    return {
      sessionId,
      kind: "assistant_message_patch",
      sessionVersion,
      payload: {
        type: "message_update",
        assistantMessageEvent: toAssistantMessageSyncEvent(event.assistantMessageEvent),
      },
      ts,
    };
  }

  if (event.type === "tool_execution_start") {
    return {
      sessionId,
      kind: "tool_execution_patch",
      sessionVersion,
      payload: {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: toJsonValue(event.args) ?? null,
      },
      ts,
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
        sessionId,
        kind: "tool_execution_patch",
        sessionVersion,
        payload: {
          type: "tool_execution_output_delta",
          toolCallId: event.toolCallId,
          delta: outputDelta,
        },
        ts,
      };
    }

    return {
      sessionId,
      kind: "tool_execution_patch",
      sessionVersion,
      payload: {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        partialResult: nextPartialResult,
      },
      ts,
    };
  }

  if (event.type === "tool_execution_end") {
    return {
      sessionId,
      kind: "tool_execution_patch",
      sessionVersion,
      payload: {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        result: toJsonValue(event.result) ?? null,
        isError: event.isError,
      },
      ts,
    };
  }

  return undefined;
}

function readToolPartialOutputDelta(
  previous: JsonValue | undefined,
  next: JsonValue,
): string | undefined {
  const previousText = readToolPartialOutputText(previous);
  const nextText = readToolPartialOutputText(next);
  if (previousText === undefined || nextText === undefined || !nextText.startsWith(previousText)) {
    return undefined;
  }

  return nextText.slice(previousText.length);
}

function readToolPartialOutputText(value: JsonValue | undefined): string | undefined {
  return readToolOutputText(value);
}
