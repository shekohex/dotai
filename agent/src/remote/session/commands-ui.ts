import type {
  CommandAcceptedResponse,
  ExtensionUiResolvedEventPayload,
  SessionNameUpdateRequest,
  UiResponseRequest,
  UiResponseResponse,
} from "../schemas.js";
import type { AuthSession } from "../auth.js";
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { AcceptedSessionCommand, SessionRecord } from "./types.js";

export function handleSessionNameUpdateCommand(input: {
  command: SessionNameUpdateRequest;
  client: AuthSession;
  connectionId?: string;
  record: SessionRecord;
  now: () => number;
  session: AgentSessionRuntime["session"] | undefined;
  acceptCommand: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: "session-name",
    payload: SessionNameUpdateRequest,
    hooks: { onAccepted: (accepted: AcceptedSessionCommand) => void },
  ) => Promise<CommandAcceptedResponse>;
  appendSessionNamePatchedEvent: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    updatedAt: number,
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): Promise<CommandAcceptedResponse> {
  return input.acceptCommand(
    input.record,
    input.client,
    input.connectionId,
    "session-name",
    input.command,
    {
      onAccepted: (accepted) => {
        const updatedAt = input.now();
        input.record.sessionName = input.command.sessionName;
        input.session?.setSessionName(input.command.sessionName);
        input.record.updatedAt = updatedAt;
        input.appendSessionNamePatchedEvent(input.record, accepted, updatedAt);
        input.emitSessionSummaryUpdated(input.record, updatedAt);
      },
    },
  );
}

export function submitUiResponseCommand(input: {
  record: SessionRecord;
  request: UiResponseRequest;
  client: AuthSession;
  connectionId: string;
  now: () => number;
  appendUiResolvedEvent: (payload: ExtensionUiResolvedEventPayload) => void;
}): UiResponseResponse {
  const pending = input.record.pendingUiRequests.get(input.request.id);
  if (!pending) {
    return { resolved: false };
  }

  input.record.pendingUiRequests.delete(input.request.id);
  if (input.record.activeRun?.pendingUiRequestId === input.request.id) {
    input.record.activeRun.pendingUiRequestId = undefined;
    input.record.activeRun.updatedAt = input.now();
  }
  const resolvedAt = input.now();
  pending.resolve(input.request);

  input.appendUiResolvedEvent({
    id: input.request.id,
    resolvedAt,
    resolvedByClientId: input.client.clientId,
    resolvedByConnectionId: input.connectionId,
    response: input.request,
  });

  return { resolved: true };
}
