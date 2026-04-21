import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type {
  CommandAcceptedResponse,
  DraftUpdateRequest,
  FollowUpCommandRequest,
  InterruptCommandRequest,
  PromptCommandRequest,
  SteerCommandRequest,
} from "../schemas.js";
import type { AuthSession } from "../auth.js";
import type { AcceptedSessionCommand, SessionRecord } from "./types.js";

function toImageAttachments(attachments: string[] | undefined): ImageContent[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  return attachments.map((attachment) => {
    const matched = /^data:([^;,]+);base64,(.+)$/.exec(attachment);
    if (matched) {
      return {
        type: "image",
        mimeType: matched[1] ?? "application/octet-stream",
        data: matched[2] ?? "",
      };
    }

    return {
      type: "image",
      mimeType: "application/octet-stream",
      data: attachment,
    };
  });
}

export function handlePromptCommand(input: {
  sessionId: string;
  command: PromptCommandRequest;
  client: AuthSession;
  connectionId?: string;
  record: SessionRecord;
  session: AgentSessionRuntime["session"];
  acceptCommand: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: "prompt",
    payload: PromptCommandRequest,
    hooks: {
      beforeAccepted?: () => Promise<void>;
      onAccepted: (accepted: AcceptedSessionCommand) => void;
    },
  ) => Promise<CommandAcceptedResponse>;
  isRegisteredExtensionCommand: (session: AgentSessionRuntime["session"], text: string) => boolean;
  ensurePromptPreflight: (session: AgentSessionRuntime["session"]) => Promise<void>;
  dispatchRuntimeCommand: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    operation: () => Promise<void>,
  ) => void;
}): Promise<CommandAcceptedResponse> {
  return input.acceptCommand(
    input.record,
    input.client,
    input.connectionId,
    "prompt",
    input.command,
    buildPromptHooks(input),
  );
}

function buildPromptHooks(input: {
  command: PromptCommandRequest;
  record: SessionRecord;
  session: AgentSessionRuntime["session"];
  isRegisteredExtensionCommand: (session: AgentSessionRuntime["session"], text: string) => boolean;
  ensurePromptPreflight: (session: AgentSessionRuntime["session"]) => Promise<void>;
  dispatchRuntimeCommand: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    operation: () => Promise<void>,
  ) => void;
}): {
  beforeAccepted: () => Promise<void>;
  onAccepted: (accepted: AcceptedSessionCommand) => void;
} {
  return {
    beforeAccepted: async () => {
      if (input.isRegisteredExtensionCommand(input.session, input.command.text)) {
        return;
      }
      if (input.session.isStreaming) {
        return;
      }
      await input.ensurePromptPreflight(input.session);
    },
    onAccepted: (accepted) => {
      input.dispatchRuntimeCommand(input.record, accepted, async () => {
        await input.session.prompt(
          input.command.text,
          toPromptOptions(input.session.isStreaming, input.command.attachments),
        );
      });
    },
  };
}

function toPromptOptions(
  isStreaming: boolean,
  attachments: string[] | undefined,
):
  | {
      images?: ImageContent[];
      streamingBehavior?: "followUp";
    }
  | undefined {
  const images = toImageAttachments(attachments);
  if (isStreaming) {
    return images === undefined
      ? { streamingBehavior: "followUp" }
      : { images, streamingBehavior: "followUp" };
  }
  if (images !== undefined) {
    return { images };
  }
  return undefined;
}

export function handleSteerCommand(input: {
  command: SteerCommandRequest;
  client: AuthSession;
  connectionId?: string;
  record: SessionRecord;
  acceptCommand: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: "steer",
    payload: SteerCommandRequest,
    onAccepted: (accepted: AcceptedSessionCommand) => void,
  ) => Promise<CommandAcceptedResponse>;
  requireRuntimeSession: (record: SessionRecord) => AgentSessionRuntime["session"];
  dispatchRuntimeCommand: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    operation: () => Promise<void>,
  ) => void;
}): Promise<CommandAcceptedResponse> {
  return input.acceptCommand(
    input.record,
    input.client,
    input.connectionId,
    "steer",
    input.command,
    (accepted) => {
      input.dispatchRuntimeCommand(input.record, accepted, async () => {
        const session = input.requireRuntimeSession(input.record);
        await session.steer(input.command.text, toImageAttachments(input.command.attachments));
      });
    },
  );
}

export function handleFollowUpCommand(input: {
  command: FollowUpCommandRequest;
  client: AuthSession;
  connectionId?: string;
  record: SessionRecord;
  acceptCommand: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: "follow-up",
    payload: FollowUpCommandRequest,
    onAccepted: (accepted: AcceptedSessionCommand) => void,
  ) => Promise<CommandAcceptedResponse>;
  requireRuntimeSession: (record: SessionRecord) => AgentSessionRuntime["session"];
  dispatchRuntimeCommand: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    operation: () => Promise<void>,
  ) => void;
}): Promise<CommandAcceptedResponse> {
  return input.acceptCommand(
    input.record,
    input.client,
    input.connectionId,
    "follow-up",
    input.command,
    (accepted) => {
      input.dispatchRuntimeCommand(input.record, accepted, async () => {
        const session = input.requireRuntimeSession(input.record);
        await session.followUp(input.command.text, toImageAttachments(input.command.attachments));
      });
    },
  );
}

export function handleInterruptCommand(input: {
  command: InterruptCommandRequest;
  client: AuthSession;
  connectionId?: string;
  record: SessionRecord;
  acceptCommand: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: "interrupt",
    payload: InterruptCommandRequest,
    onAccepted: (accepted: AcceptedSessionCommand) => void,
  ) => Promise<CommandAcceptedResponse>;
  requireRuntimeSession: (record: SessionRecord) => AgentSessionRuntime["session"];
  dispatchRuntimeCommand: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    operation: () => Promise<void>,
  ) => void;
}): Promise<CommandAcceptedResponse> {
  return input.acceptCommand(
    input.record,
    input.client,
    input.connectionId,
    "interrupt",
    input.command,
    (accepted) => {
      input.dispatchRuntimeCommand(input.record, accepted, async () => {
        const session = input.requireRuntimeSession(input.record);
        session.clearQueue();
        await session.abort();
      });
    },
  );
}

export function handleDraftUpdateCommand(input: {
  command: DraftUpdateRequest;
  client: AuthSession;
  connectionId?: string;
  record: SessionRecord;
  now: () => number;
  acceptCommand: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: "draft",
    payload: DraftUpdateRequest,
    onAccepted: (accepted: AcceptedSessionCommand) => void,
  ) => Promise<CommandAcceptedResponse>;
  appendDraftUpdatedEvent: (
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
    "draft",
    input.command,
    (accepted) => {
      const updatedAt = input.now();
      input.record.draft.text = input.command.text;
      input.record.draft.attachments = [...(input.command.attachments ?? [])];
      input.record.draft.revision += 1;
      input.record.draft.updatedAt = updatedAt;
      input.record.draft.updatedByClientId = input.client.clientId;
      input.record.updatedAt = updatedAt;
      input.appendDraftUpdatedEvent(input.record, accepted, updatedAt);
      input.emitSessionSummaryUpdated(input.record, updatedAt);
    },
  );
}
