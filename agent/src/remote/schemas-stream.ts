import { Type } from "@sinclair/typebox";
import {
  CommandKindSchema,
  DraftSchema,
  PresenceSchema,
  RemoteExtensionMetadataSchema,
  RemoteModelSchema,
  RemoteModelSettingsSchema,
  SessionStatusSchema,
} from "./schemas-core.js";

const StreamEventCommonProperties = {
  eventId: Type.String(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  streamOffset: Type.String(),
  ts: Type.Number(),
};

const SessionCreatedEventPayloadSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  status: SessionStatusSchema,
});

const SessionClosedEventPayloadSchema = Type.Object({
  sessionId: Type.String(),
});

const SessionSummaryUpdatedEventPayloadSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  status: SessionStatusSchema,
  draftRevision: Type.Number(),
  updatedAt: Type.Number(),
});

const ClientPresenceUpdatedEventPayloadSchema = Type.Object({
  sessionId: Type.String(),
  presence: Type.Array(PresenceSchema),
});

const AuthNoticeEventPayloadSchema = Type.Object({
  message: Type.String(),
});

const ServerNoticeEventPayloadSchema = Type.Object({
  message: Type.String(),
});

const AgentSessionEventPayloadSchema = Type.Object(
  {
    type: Type.String(),
  },
  { additionalProperties: true },
);

const CommandAcceptedEventPayloadSchema = Type.Object({
  commandId: Type.String(),
  sessionId: Type.String(),
  clientId: Type.String(),
  requestId: Type.Union([Type.String(), Type.Null()]),
  kind: CommandKindSchema,
  payload: Type.Unknown(),
  acceptedAt: Type.Number(),
  sequence: Type.Number(),
});

const DraftUpdatedEventPayloadSchema = Type.Object({
  commandId: Type.String(),
  sequence: Type.Number(),
  draft: DraftSchema,
});

const SessionStatePatchEventPayloadSchema = Type.Object({
  commandId: Type.String(),
  sequence: Type.Number(),
  patch: Type.Object(
    {
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      sessionName: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      extensions: Type.Optional(Type.Array(RemoteExtensionMetadataSchema)),
      availableModels: Type.Optional(Type.Array(RemoteModelSchema)),
      modelSettings: Type.Optional(RemoteModelSettingsSchema),
    },
    { minProperties: 1 },
  ),
});

export const ExtensionUiRequestEventPayloadSchema = Type.Union([
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("select"),
    title: Type.String(),
    options: Type.Array(Type.String()),
    timeout: Type.Optional(Type.Number()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("confirm"),
    title: Type.String(),
    message: Type.String(),
    timeout: Type.Optional(Type.Number()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("input"),
    title: Type.String(),
    placeholder: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("editor"),
    title: Type.String(),
    prefill: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("notify"),
    message: Type.String(),
    notifyType: Type.Optional(
      Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
    ),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setStatus"),
    statusKey: Type.String(),
    statusText: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setWorkingMessage"),
    message: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setHiddenThinkingLabel"),
    label: Type.Optional(Type.String()),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setWidget"),
    widgetKey: Type.String(),
    widgetLines: Type.Optional(Type.Array(Type.String())),
    widgetPlacement: Type.Optional(
      Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")]),
    ),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setTitle"),
    title: Type.String(),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setHeader"),
    lines: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setFooter"),
    lines: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("setToolsExpanded"),
    expanded: Type.Boolean(),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("set_editor_text"),
    text: Type.String(),
  }),
]);

const ExtensionErrorEventPayloadSchema = Type.Object({
  commandId: Type.String(),
  kind: CommandKindSchema,
  error: Type.String(),
});

export const StreamEventEnvelopeSchema = Type.Union([
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("session_created"),
    payload: SessionCreatedEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("session_closed"),
    payload: SessionClosedEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("session_summary_updated"),
    payload: SessionSummaryUpdatedEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("client_presence_updated"),
    payload: ClientPresenceUpdatedEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("auth_notice"),
    payload: AuthNoticeEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("server_notice"),
    payload: ServerNoticeEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("agent_session_event"),
    payload: AgentSessionEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("command_accepted"),
    payload: CommandAcceptedEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("draft_updated"),
    payload: DraftUpdatedEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("session_state_patch"),
    payload: SessionStatePatchEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("extension_ui_request"),
    payload: ExtensionUiRequestEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("extension_error"),
    payload: ExtensionErrorEventPayloadSchema,
  }),
]);

export const StreamReadResponseSchema = Type.Object({
  streamId: Type.String(),
  fromOffset: Type.Union([Type.String(), Type.Null()]),
  nextOffset: Type.String(),
  streamCursor: Type.Optional(Type.String()),
  upToDate: Type.Boolean(),
  streamClosed: Type.Boolean(),
  events: Type.Array(StreamEventEnvelopeSchema),
});
