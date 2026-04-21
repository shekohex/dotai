import { sessionEventsStreamId, type InMemoryDurableStreamStore } from "../streams.js";
import type { AuthSession } from "../auth.js";
import type { CommandAcceptedResponse, CommandKind } from "../schemas.js";
import { acceptSessionCommand } from "./command-acceptance.js";
import { dispatchRuntimeCommand } from "./runtime-command.js";
import type { AcceptCommandHooks, AcceptedSessionCommand, SessionRecord } from "./types.js";

export function acceptSessionCommandWithStreams<TPayload>(input: {
  streams: InMemoryDurableStreamStore;
  record: SessionRecord;
  client: AuthSession;
  connectionId: string | undefined;
  kind: CommandKind;
  payload: TPayload & { requestId?: string };
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
}): Promise<CommandAcceptedResponse> {
  return acceptSessionCommand({
    record: input.record,
    client: input.client,
    connectionId: input.connectionId,
    kind: input.kind,
    payload: input.payload,
    hooksOrOnAccepted: input.hooksOrOnAccepted,
    createCommandId: input.createCommandId,
    now: input.now,
    touchPresence: input.touchPresence,
    appendCommandAccepted: (targetRecord, accepted, acceptedAt) => {
      input.streams.append(sessionEventsStreamId(targetRecord.sessionId), {
        sessionId: targetRecord.sessionId,
        kind: "command_accepted",
        payload: accepted,
        ts: acceptedAt,
      });
    },
    syncFromRuntime: input.syncFromRuntime,
  });
}

export function dispatchRuntimeCommandWithStreams(input: {
  streams: InMemoryDurableStreamStore;
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
      input.streams.append(sessionEventsStreamId(targetRecord.sessionId), {
        sessionId: targetRecord.sessionId,
        kind: "extension_error",
        payload: {
          commandId: acceptedCommand.commandId,
          kind: acceptedCommand.kind,
          error: message,
        },
        ts: targetRecord.updatedAt,
      });
    },
    emitSessionSummaryUpdated: input.emitSessionSummaryUpdated,
  });
}
