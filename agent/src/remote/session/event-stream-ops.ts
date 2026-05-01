import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
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
    appendAgentEvent: (targetRecord, targetEvent, ts, sessionVersion) => {
      const streamId = sessionEventsStreamId(targetRecord.sessionId);
      const append = isLiveOnlyAgentSessionEvent(targetEvent)
        ? appendLiveOnlyAndPublish
        : appendAndPublish;
      append(input.streams, input.liveEvents, streamId, {
        sessionId: targetRecord.sessionId,
        kind: "agent_session_event",
        sessionVersion,
        payload: targetEvent,
        ts,
      });
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

function isLiveOnlyAgentSessionEvent(event: AgentSessionEvent): boolean {
  return (
    (event.type === "message_update" && event.message.role === "assistant") ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  );
}
