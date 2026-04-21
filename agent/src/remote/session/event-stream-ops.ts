import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  appEventsStreamId,
  sessionEventsStreamId,
  type InMemoryDurableStreamStore,
} from "../streams.js";
import { hasExtensionMetadataChange } from "./helpers.js";
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
      draftRevision: input.record.draft.revision,
      updatedAt: input.record.updatedAt,
    },
    ts: input.ts,
  });
  input.record.lastAppStreamOffsetSeenByServer = event.streamOffset;
}

export function appendExtensionUiRequestEvent(input: {
  streams: InMemoryDurableStreamStore;
  record: SessionRecord;
  payload: import("../schemas.js").ExtensionUiRequestEventPayload;
  ts: number;
}): void {
  input.streams.append(sessionEventsStreamId(input.record.sessionId), {
    sessionId: input.record.sessionId,
    kind: "extension_ui_request",
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

  handleSessionEventForRecord({
    record,
    event: input.event,
    now: input.now,
    createRunId: input.createRunId,
    syncFromRuntime: input.syncFromRuntime,
    hasExtensionMetadataChange,
    appendAgentEvent: (targetRecord, targetEvent, ts) => {
      input.streams.append(sessionEventsStreamId(targetRecord.sessionId), {
        sessionId: targetRecord.sessionId,
        kind: "agent_session_event",
        payload: targetEvent,
        ts,
      });
    },
    appendSessionStatePatch: (targetRecord, patch, ts) => {
      input.streams.append(sessionEventsStreamId(targetRecord.sessionId), {
        sessionId: targetRecord.sessionId,
        kind: "session_state_patch",
        payload: {
          commandId: "server-state-sync",
          sequence: targetRecord.queue.nextSequence,
          patch,
        },
        ts,
      });
    },
    emitSessionSummaryUpdated: input.emitSessionSummaryUpdated,
  });
}
