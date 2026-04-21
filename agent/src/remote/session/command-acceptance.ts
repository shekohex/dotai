import type { CommandKind, CommandAcceptedResponse } from "../schemas.js";
import type { AuthSession } from "../auth.js";
import type { AcceptCommandHooks, AcceptedSessionCommand, SessionRecord } from "./types.js";

function toCommandAcceptedResponse(accepted: AcceptedSessionCommand): CommandAcceptedResponse {
  return {
    commandId: accepted.commandId,
    sessionId: accepted.sessionId,
    kind: accepted.kind,
    sequence: accepted.sequence,
    acceptedAt: accepted.acceptedAt,
  };
}

function enqueueCommandAcceptance<T>(
  record: SessionRecord,
  operation: () => Promise<T>,
): Promise<T> {
  const pending = record.commandAcceptanceQueue.then(operation, operation);
  record.commandAcceptanceQueue = pending.then(
    () => {},
    () => {},
  );
  return pending;
}

function resolveAcceptCommandHooks(
  hooksOrOnAccepted:
    | AcceptCommandHooks
    | ((accepted: AcceptedSessionCommand) => Promise<void> | void),
): AcceptCommandHooks {
  return typeof hooksOrOnAccepted === "function"
    ? { onAccepted: hooksOrOnAccepted }
    : hooksOrOnAccepted;
}

function buildAcceptedCommand<TPayload>(input: {
  record: SessionRecord;
  client: AuthSession;
  kind: CommandKind;
  payload: TPayload & { requestId?: string };
  acceptedAt: number;
  createCommandId: () => string;
}): AcceptedSessionCommand {
  return {
    commandId: input.createCommandId(),
    sessionId: input.record.sessionId,
    clientId: input.client.clientId,
    requestId: input.payload.requestId ?? null,
    kind: input.kind,
    payload: input.payload,
    acceptedAt: input.acceptedAt,
    sequence: input.record.queue.nextSequence,
  };
}

export function acceptSessionCommand<TPayload>(input: {
  record: SessionRecord;
  client: AuthSession;
  connectionId?: string;
  kind: CommandKind;
  payload: TPayload & { requestId?: string };
  hooksOrOnAccepted:
    | AcceptCommandHooks
    | ((accepted: AcceptedSessionCommand) => Promise<void> | void);
  createCommandId: () => string;
  now: () => number;
  touchPresence: (sessionId: string, client: AuthSession, connectionId?: string) => void;
  appendCommandAccepted: (
    record: SessionRecord,
    accepted: AcceptedSessionCommand,
    acceptedAt: number,
  ) => void;
  syncFromRuntime: (
    record: SessionRecord,
    options: { now: number; updateTimestamp: boolean },
  ) => void;
}): Promise<CommandAcceptedResponse> {
  const hooks = resolveAcceptCommandHooks(input.hooksOrOnAccepted);

  return enqueueCommandAcceptance(input.record, async () => {
    input.touchPresence(input.record.sessionId, input.client, input.connectionId);
    const acceptedAt = input.now();
    const accepted = buildAcceptedCommand({
      record: input.record,
      client: input.client,
      kind: input.kind,
      payload: input.payload,
      acceptedAt,
      createCommandId: input.createCommandId,
    });

    await hooks.beforeAccepted?.(accepted);

    input.record.queue.nextSequence += 1;
    input.record.updatedAt = acceptedAt;
    input.appendCommandAccepted(input.record, accepted, acceptedAt);

    await hooks.onAccepted?.(accepted);
    input.syncFromRuntime(input.record, { now: acceptedAt, updateTimestamp: false });
    return toCommandAcceptedResponse(accepted);
  });
}
