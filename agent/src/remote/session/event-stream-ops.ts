import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { readAgentSessionEventReplaceKey } from "../session-sync-metadata.js";
import {
  appEventsStreamId,
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
  record: SessionRecord;
  ts: number;
}): void {
  const event = input.streams.append(appEventsStreamId(), {
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
  record: SessionRecord;
  payload: ExtensionUiRequestEventPayload;
  ts: number;
}): void {
  input.streams.append(sessionEventsStreamId(input.record.sessionId), {
    sessionId: input.record.sessionId,
    kind: "extension_ui_request",
    sessionVersion: String(input.record.lastDurableSessionVersion),
    payload: input.payload,
    ts: input.ts,
  });
}

export function appendExtensionUiResolvedEvent(input: {
  streams: InMemoryDurableStreamStore;
  record: SessionRecord;
  payload: ExtensionUiResolvedEventPayload;
  ts: number;
}): void {
  input.streams.append(sessionEventsStreamId(input.record.sessionId), {
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

  const previousDurableRuntimeState = readDurableRuntimeState(record);

  handleSessionEventForRecord({
    record,
    event: input.event,
    now: input.now,
    createRunId: input.createRunId,
    syncFromRuntime: input.syncFromRuntime,
    hasExtensionMetadataChange,
    appendAgentEvent: (targetRecord, targetEvent, ts) => {
      const streamId = sessionEventsStreamId(targetRecord.sessionId);
      const append = isLiveOnlyAgentSessionEvent(targetEvent)
        ? input.streams.appendLiveOnly.bind(input.streams)
        : input.streams.append.bind(input.streams);
      append(streamId, {
        sessionId: targetRecord.sessionId,
        kind: "agent_session_event",
        payload: targetEvent,
        retentionKey: getAgentSessionEventRetentionKey(targetEvent),
        ts,
      });
    },
    appendSessionStatePatch: (targetRecord, patch, ts) => {
      input.streams.append(sessionEventsStreamId(targetRecord.sessionId), {
        sessionId: targetRecord.sessionId,
        kind: "session_state_patch",
        sessionVersion: String(targetRecord.lastDurableSessionVersion),
        payload: {
          commandId: "server-state-sync",
          sequence: targetRecord.queue.nextSequence,
          patch,
        },
        retentionKey: "session-state-patch",
        ts,
      });
    },
    emitSessionSummaryUpdated: input.emitSessionSummaryUpdated,
  });

  if (!didDurableRuntimeStateChange(previousDurableRuntimeState, record)) {
    return;
  }
  record.lastDurableSessionVersion += 1;
  persistDurableRuntimeDomainState({
    record,
    updatedAt: input.now,
  });
}

function readDurableRuntimeState(record: SessionRecord): {
  queueDepth: number;
  nextSequence: number;
  retryStatus: SessionRecord["retry"]["status"];
  compactionStatus: SessionRecord["compaction"]["status"];
  isBashRunning: boolean;
  hasPendingBashMessages: boolean;
  streamingState: SessionRecord["streamingState"];
} {
  return {
    queueDepth: record.queue.depth,
    nextSequence: record.queue.nextSequence,
    retryStatus: record.retry.status,
    compactionStatus: record.compaction.status,
    isBashRunning: record.isBashRunning,
    hasPendingBashMessages: record.hasPendingBashMessages,
    streamingState: record.streamingState,
  };
}

function didDurableRuntimeStateChange(
  previous: ReturnType<typeof readDurableRuntimeState>,
  record: SessionRecord,
): boolean {
  return (
    previous.queueDepth !== record.queue.depth ||
    previous.nextSequence !== record.queue.nextSequence ||
    previous.retryStatus !== record.retry.status ||
    previous.compactionStatus !== record.compaction.status ||
    previous.isBashRunning !== record.isBashRunning ||
    previous.hasPendingBashMessages !== record.hasPendingBashMessages ||
    previous.streamingState !== record.streamingState
  );
}

function getAgentSessionEventRetentionKey(event: AgentSessionEvent): string | undefined {
  const replaceKey = readAgentSessionEventReplaceKey(event);
  if (replaceKey === "agent_session_event:message_update:assistant") {
    return "assistant-message-update";
  }

  if (
    replaceKey !== undefined &&
    replaceKey.startsWith("agent_session_event:tool_execution_update:")
  ) {
    return replaceKey
      .replace("agent_session_event:", "")
      .replace("tool_execution_update:", "tool-execution-update:");
  }

  return undefined;
}

function isLiveOnlyAgentSessionEvent(event: AgentSessionEvent): boolean {
  return (
    (event.type === "message_update" && event.message.role === "assistant") ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  );
}
