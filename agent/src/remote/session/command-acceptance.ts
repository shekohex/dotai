import type { CommandKind, CommandAcceptedResponse } from "../schemas.js";
import type { AuthSession } from "../auth.js";
import { persistDurableRuntimeDomainState } from "./durable-runtime-state.js";
import type {
  AcceptCommandHooks,
  AcceptedSessionCommand,
  AcceptedSessionCommandPayload,
  SessionRecord,
} from "./types.js";

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

type BuildAcceptedCommandInput = {
  [TKind in CommandKind]: {
    record: SessionRecord;
    client: AuthSession;
    kind: TKind;
    payload: AcceptedSessionCommandPayload;
    acceptedAt: number;
    createCommandId: () => string;
  };
}[CommandKind];

function buildAcceptedCommand(input: BuildAcceptedCommandInput): AcceptedSessionCommand {
  const base = {
    commandId: input.createCommandId(),
    sessionId: input.record.sessionId,
    clientId: input.client.clientId,
    requestId: input.payload.requestId ?? null,
    acceptedAt: input.acceptedAt,
    sequence: input.record.queue.nextSequence,
  };

  switch (input.kind) {
    case "prompt":
      return { ...base, kind: input.kind, payload: input.payload };
    case "steer":
      return { ...base, kind: input.kind, payload: input.payload };
    case "follow-up":
      return { ...base, kind: input.kind, payload: input.payload };
    case "interrupt":
      return { ...base, kind: input.kind, payload: input.payload };
    case "active-tools":
      return { ...base, kind: input.kind, payload: input.payload };
    case "model":
      return { ...base, kind: input.kind, payload: input.payload };
    case "session-name":
      return { ...base, kind: input.kind, payload: input.payload };
    case "settings":
      return { ...base, kind: input.kind, payload: input.payload };
  }

  throw new Error("Unsupported command kind");
}

type AcceptSessionCommandInput = {
  [TKind in CommandKind]: {
    record: SessionRecord;
    client: AuthSession;
    connectionId?: string;
    kind: TKind;
    payload: AcceptedSessionCommandPayload;
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
  };
}[CommandKind];

export function acceptSessionCommand(
  input: AcceptSessionCommandInput,
): Promise<CommandAcceptedResponse> {
  const hooks = resolveAcceptCommandHooks(input.hooksOrOnAccepted);

  return enqueueCommandAcceptance(input.record, async () => {
    input.touchPresence(input.record.sessionId, input.client, input.connectionId);
    const acceptedAt = input.now();
    const accepted = buildAcceptedCommandForInput(input, acceptedAt);

    await hooks.beforeAccepted?.(accepted);

    input.record.queue.nextSequence += 1;
    input.record.updatedAt = acceptedAt;
    input.record.lastDurableSessionVersion += 1;
    input.appendCommandAccepted(input.record, accepted, acceptedAt);

    await hooks.onAccepted?.(accepted);
    input.syncFromRuntime(input.record, { now: acceptedAt, updateTimestamp: false });
    persistDurableRuntimeDomainState({ record: input.record, updatedAt: acceptedAt });
    return toCommandAcceptedResponse(accepted);
  });
}

function buildAcceptedCommandForInput(
  input: AcceptSessionCommandInput,
  acceptedAt: number,
): AcceptedSessionCommand {
  switch (input.kind) {
    case "prompt":
      return buildAcceptedCommand({ ...input, acceptedAt });
    case "steer":
      return buildAcceptedCommand({ ...input, acceptedAt });
    case "follow-up":
      return buildAcceptedCommand({ ...input, acceptedAt });
    case "interrupt":
      return buildAcceptedCommand({ ...input, acceptedAt });
    case "active-tools":
      return buildAcceptedCommand({ ...input, acceptedAt });
    case "model":
      return buildAcceptedCommand({ ...input, acceptedAt });
    case "session-name":
      return buildAcceptedCommand({ ...input, acceptedAt });
    case "settings":
      return buildAcceptedCommand({ ...input, acceptedAt });
  }

  throw new Error("Unsupported command kind");
}
