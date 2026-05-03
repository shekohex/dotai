import {
  appendAndPublish,
  sessionEventsStreamId,
  type InMemoryDurableStreamStore,
} from "../streams.js";
import type { AuthSession } from "../auth.js";
import type { SessionLiveEventBus } from "../live-events.js";
import type { CommandAcceptedResponse, CommandKind, SessionSyncEvent } from "../schemas.js";
import { acceptSessionCommand } from "./command-acceptance.js";
import { dispatchRuntimeCommand } from "./runtime-command.js";
import type {
  AcceptCommandHooks,
  AcceptedSessionCommand,
  AcceptedSessionCommandPayload,
  SessionRecord,
} from "./types.js";

function publishSessionSyncPatch(
  liveEvents: SessionLiveEventBus | undefined,
  sessionId: string,
  event: Extract<SessionSyncEvent, { type: "patch" }>,
): void {
  liveEvents?.publishSessionSyncEvent(sessionId, event);
}

type AcceptSessionCommandWithStreamsInput = {
  [TKind in CommandKind]: {
    streams: InMemoryDurableStreamStore;
    liveEvents?: SessionLiveEventBus;
    record: SessionRecord;
    client: AuthSession;
    connectionId: string | undefined;
    kind: TKind;
    payload: AcceptedSessionCommandPayload;
    hooksOrOnAccepted:
      | AcceptCommandHooks
      | ((accepted: AcceptedSessionCommand) => Promise<void> | void);
    createCommandId: () => string;
    now: () => number;
    touchPresence: (sessionId: string, client: AuthSession, connectionId?: string) => void;
    syncFromRuntime: (
      record: SessionRecord,
      options: { now: number; updateTimestamp: boolean },
    ) => void;
  };
}[CommandKind];

export function acceptSessionCommandWithStreams(
  input: AcceptSessionCommandWithStreamsInput,
): Promise<CommandAcceptedResponse> {
  const base = {
    record: input.record,
    client: input.client,
    connectionId: input.connectionId,
    hooksOrOnAccepted: input.hooksOrOnAccepted,
    createCommandId: input.createCommandId,
    now: input.now,
    touchPresence: input.touchPresence,
    appendCommandAccepted: (
      targetRecord: SessionRecord,
      accepted: AcceptedSessionCommand,
      acceptedAt: number,
    ) => {
      const payload = toCommandAcceptedEventPayload(accepted);
      appendAndPublish(
        input.streams,
        input.liveEvents,
        sessionEventsStreamId(targetRecord.sessionId),
        {
          sessionId: targetRecord.sessionId,
          kind: "command_accepted",
          sessionVersion: String(targetRecord.lastDurableSessionVersion),
          payload,
          ts: acceptedAt,
        },
      );
      publishSessionSyncPatch(input.liveEvents, targetRecord.sessionId, {
        type: "patch",
        sessionId: targetRecord.sessionId,
        version: String(targetRecord.lastDurableSessionVersion),
        patch: { patchType: "command.accepted", payload },
      });
    },
    syncFromRuntime: input.syncFromRuntime,
  };

  switch (input.kind) {
    case "prompt":
      return acceptSessionCommand({ ...base, kind: input.kind, payload: input.payload });
    case "steer":
      return acceptSessionCommand({ ...base, kind: input.kind, payload: input.payload });
    case "follow-up":
      return acceptSessionCommand({ ...base, kind: input.kind, payload: input.payload });
    case "interrupt":
      return acceptSessionCommand({ ...base, kind: input.kind, payload: input.payload });
    case "active-tools":
      return acceptSessionCommand({ ...base, kind: input.kind, payload: input.payload });
    case "model":
      return acceptSessionCommand({ ...base, kind: input.kind, payload: input.payload });
    case "session-name":
      return acceptSessionCommand({ ...base, kind: input.kind, payload: input.payload });
    case "settings":
      return acceptSessionCommand({ ...base, kind: input.kind, payload: input.payload });
  }

  throw new Error("Unsupported command kind");
}

function toCommandAcceptedEventPayload(
  accepted: AcceptedSessionCommand,
): Extract<
  Parameters<InMemoryDurableStreamStore["append"]>[1],
  { kind: "command_accepted" }
>["payload"] {
  switch (accepted.kind) {
    case "prompt":
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        clientId: accepted.clientId,
        requestId: accepted.requestId,
        kind: accepted.kind,
        payload: accepted.payload,
        acceptedAt: accepted.acceptedAt,
        sequence: accepted.sequence,
      };
    case "steer":
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        clientId: accepted.clientId,
        requestId: accepted.requestId,
        kind: accepted.kind,
        payload: accepted.payload,
        acceptedAt: accepted.acceptedAt,
        sequence: accepted.sequence,
      };
    case "follow-up":
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        clientId: accepted.clientId,
        requestId: accepted.requestId,
        kind: accepted.kind,
        payload: accepted.payload,
        acceptedAt: accepted.acceptedAt,
        sequence: accepted.sequence,
      };
    case "interrupt":
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        clientId: accepted.clientId,
        requestId: accepted.requestId,
        kind: accepted.kind,
        payload: accepted.payload,
        acceptedAt: accepted.acceptedAt,
        sequence: accepted.sequence,
      };
    case "active-tools":
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        clientId: accepted.clientId,
        requestId: accepted.requestId,
        kind: accepted.kind,
        payload: accepted.payload,
        acceptedAt: accepted.acceptedAt,
        sequence: accepted.sequence,
      };
    case "model":
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        clientId: accepted.clientId,
        requestId: accepted.requestId,
        kind: accepted.kind,
        payload: accepted.payload,
        acceptedAt: accepted.acceptedAt,
        sequence: accepted.sequence,
      };
    case "session-name":
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        clientId: accepted.clientId,
        requestId: accepted.requestId,
        kind: accepted.kind,
        payload: accepted.payload,
        acceptedAt: accepted.acceptedAt,
        sequence: accepted.sequence,
      };
    case "settings":
      return {
        commandId: accepted.commandId,
        sessionId: accepted.sessionId,
        clientId: accepted.clientId,
        requestId: accepted.requestId,
        kind: accepted.kind,
        payload: accepted.payload,
        acceptedAt: accepted.acceptedAt,
        sequence: accepted.sequence,
      };
  }

  throw new Error("Unsupported command kind");
}

export function dispatchRuntimeCommandWithStreams(input: {
  streams: InMemoryDurableStreamStore;
  liveEvents?: SessionLiveEventBus;
  record: SessionRecord;
  command: AcceptedSessionCommand;
  operation: () => Promise<void>;
  syncFromRuntime: (record: SessionRecord, options?: { updateTimestamp?: boolean }) => void;
  getRuntimeSession: (record: SessionRecord) => { isStreaming: boolean } | undefined;
  now: () => number;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): void {
  dispatchRuntimeCommand({
    record: input.record,
    command: input.command,
    operation: input.operation,
    syncFromRuntime: input.syncFromRuntime,
    getRuntimeSession: input.getRuntimeSession,
    now: input.now,
    appendExtensionError: (targetRecord, acceptedCommand, message) => {
      const payload = {
        commandId: acceptedCommand.commandId,
        kind: acceptedCommand.kind,
        error: message,
      };
      appendAndPublish(
        input.streams,
        input.liveEvents,
        sessionEventsStreamId(targetRecord.sessionId),
        {
          sessionId: targetRecord.sessionId,
          kind: "extension_error",
          sessionVersion: String(targetRecord.lastDurableSessionVersion),
          payload,
          ts: targetRecord.updatedAt,
        },
      );
      publishSessionSyncPatch(input.liveEvents, targetRecord.sessionId, {
        type: "patch",
        sessionId: targetRecord.sessionId,
        version: String(targetRecord.lastDurableSessionVersion),
        patch: { patchType: "extension.error", payload },
      });
    },
    emitSessionSummaryUpdated: input.emitSessionSummaryUpdated,
  });
}
