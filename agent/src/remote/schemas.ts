import { Type, type Static } from "@sinclair/typebox";

export const SessionStatusSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("compacting"),
  Type.Literal("retrying"),
  Type.Literal("error"),
  Type.Literal("closed"),
]);

export const AuthChallengeRequestSchema = Type.Object({
  keyId: Type.String({ minLength: 1 }),
});

export const AuthChallengeResponseSchema = Type.Object({
  challengeId: Type.String(),
  nonce: Type.String(),
  origin: Type.String(),
  expiresAt: Type.Number(),
  algorithm: Type.Literal("ed25519"),
});

export const AuthVerifyRequestSchema = Type.Object({
  challengeId: Type.String({ minLength: 1 }),
  keyId: Type.String({ minLength: 1 }),
  signature: Type.String({ minLength: 1 }),
});

export const AuthVerifyResponseSchema = Type.Object({
  token: Type.String(),
  tokenType: Type.Literal("Bearer"),
  expiresAt: Type.Number(),
  clientId: Type.String(),
  keyId: Type.String(),
});

export const ErrorResponseSchema = Type.Object({
  error: Type.String(),
  details: Type.Optional(Type.String()),
});

export const DraftSchema = Type.Object({
  text: Type.String(),
  attachments: Type.Array(Type.String()),
  revision: Type.Number(),
  updatedAt: Type.Number(),
  updatedByClientId: Type.Union([Type.String(), Type.Null()]),
});

export const PresenceSchema = Type.Object({
  clientId: Type.String(),
  deviceId: Type.Optional(Type.String()),
  connectionId: Type.String(),
  connectedAt: Type.Number(),
  lastSeenAt: Type.Number(),
  clientCapabilities: Type.Optional(Type.Record(Type.String(), Type.String())),
  lastSeenSessionOffset: Type.String(),
  lastSeenAppOffset: Type.String(),
});

export const SessionSummarySchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  status: SessionStatusSchema,
  draftRevision: Type.Number(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  lastSessionStreamOffset: Type.String(),
});

export const RemoteModelSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  api: Type.String(),
  provider: Type.String(),
  baseUrl: Type.String(),
  reasoning: Type.Boolean(),
  input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
  }),
  contextWindow: Type.Number(),
  maxTokens: Type.Number(),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(Type.Unknown()),
});

export const RemoteModelSettingsSchema = Type.Object({
  defaultProvider: Type.Union([Type.String(), Type.Null()]),
  defaultModel: Type.Union([Type.String(), Type.Null()]),
  defaultThinkingLevel: Type.Union([Type.String(), Type.Null()]),
  enabledModels: Type.Union([Type.Array(Type.String()), Type.Null()]),
});

export const AppSnapshotSchema = Type.Object({
  serverInfo: Type.Object({
    name: Type.String(),
    version: Type.String(),
    now: Type.Number(),
  }),
  currentClientAuthInfo: Type.Object({
    clientId: Type.String(),
    keyId: Type.String(),
    tokenExpiresAt: Type.Number(),
  }),
  sessionSummaries: Type.Array(SessionSummarySchema),
  recentNotices: Type.Array(Type.String()),
  defaultAttachSessionId: Type.Optional(Type.String()),
});

export const CreateSessionRequestSchema = Type.Object({
  sessionName: Type.Optional(Type.String({ minLength: 1 })),
});

export const CreateSessionResponseSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  status: SessionStatusSchema,
});

export const SessionParamsSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
});

export const PromptCommandRequestSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  attachments: Type.Optional(Type.Array(Type.String())),
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});

export const SteerCommandRequestSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  attachments: Type.Optional(Type.Array(Type.String())),
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});

export const FollowUpCommandRequestSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  attachments: Type.Optional(Type.Array(Type.String())),
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});

export const InterruptCommandRequestSchema = Type.Object({
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});

export const DraftUpdateRequestSchema = Type.Object({
  text: Type.String(),
  attachments: Type.Optional(Type.Array(Type.String())),
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});

export const ModelUpdateRequestSchema = Type.Object({
  model: Type.String({ minLength: 1 }),
  thinkingLevel: Type.Optional(Type.String({ minLength: 1 })),
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});

export const SessionNameUpdateRequestSchema = Type.Object({
  sessionName: Type.String({ minLength: 1 }),
  requestId: Type.Optional(Type.String({ minLength: 1 })),
});

export const UiResponseRequestSchema = Type.Union([
  Type.Object({
    id: Type.String({ minLength: 1 }),
    value: Type.String(),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    confirmed: Type.Boolean(),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    cancelled: Type.Literal(true),
  }),
]);

export const UiResponseResponseSchema = Type.Object({
  resolved: Type.Boolean(),
});

export const ClearQueueResponseSchema = Type.Object({
  steering: Type.Array(Type.String()),
  followUp: Type.Array(Type.String()),
});

export const CommandKindSchema = Type.Union([
  Type.Literal("prompt"),
  Type.Literal("steer"),
  Type.Literal("follow-up"),
  Type.Literal("interrupt"),
  Type.Literal("draft"),
  Type.Literal("model"),
  Type.Literal("session-name"),
]);

export const CommandAcceptedResponseSchema = Type.Object({
  commandId: Type.String(),
  sessionId: Type.String(),
  kind: CommandKindSchema,
  sequence: Type.Number(),
  acceptedAt: Type.Number(),
});

export const SessionSnapshotSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  status: SessionStatusSchema,
  model: Type.String(),
  thinkingLevel: Type.String(),
  activeTools: Type.Array(Type.String()),
  availableModels: Type.Array(RemoteModelSchema),
  modelSettings: RemoteModelSettingsSchema,
  draft: DraftSchema,
  draftRevision: Type.Number(),
  transcript: Type.Array(Type.Unknown()),
  queue: Type.Object({
    depth: Type.Number(),
    nextSequence: Type.Number(),
  }),
  retry: Type.Object({
    status: Type.String(),
  }),
  compaction: Type.Object({
    status: Type.String(),
  }),
  presence: Type.Array(PresenceSchema),
  activeRun: Type.Union([
    Type.Null(),
    Type.Object({
      runId: Type.String(),
      status: Type.String(),
      triggeringCommandId: Type.String(),
      startedAt: Type.Number(),
      updatedAt: Type.Number(),
      pendingUiRequestId: Type.Optional(Type.String()),
      queueDepth: Type.Number(),
    }),
  ]),
  lastSessionStreamOffset: Type.String(),
  lastAppStreamOffsetSeenByServer: Type.String(),
  streamingState: Type.String(),
  pendingToolCalls: Type.Array(Type.Unknown()),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});

export const StreamReadQuerySchema = Type.Object({
  offset: Type.Optional(Type.String()),
  live: Type.Optional(
    Type.Union([Type.Literal("json"), Type.Literal("sse"), Type.Literal("long-poll")]),
  ),
  cursor: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
});

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

export type AuthChallengeRequest = Static<typeof AuthChallengeRequestSchema>;
export type AuthChallengeResponse = Static<typeof AuthChallengeResponseSchema>;
export type AuthVerifyRequest = Static<typeof AuthVerifyRequestSchema>;
export type AuthVerifyResponse = Static<typeof AuthVerifyResponseSchema>;
export type AppSnapshot = Static<typeof AppSnapshotSchema>;
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = Static<typeof CreateSessionResponseSchema>;
export type PromptCommandRequest = Static<typeof PromptCommandRequestSchema>;
export type SteerCommandRequest = Static<typeof SteerCommandRequestSchema>;
export type FollowUpCommandRequest = Static<typeof FollowUpCommandRequestSchema>;
export type InterruptCommandRequest = Static<typeof InterruptCommandRequestSchema>;
export type DraftUpdateRequest = Static<typeof DraftUpdateRequestSchema>;
export type ModelUpdateRequest = Static<typeof ModelUpdateRequestSchema>;
export type SessionNameUpdateRequest = Static<typeof SessionNameUpdateRequestSchema>;
export type UiResponseRequest = Static<typeof UiResponseRequestSchema>;
export type UiResponseResponse = Static<typeof UiResponseResponseSchema>;
export type ClearQueueResponse = Static<typeof ClearQueueResponseSchema>;
export type CommandKind = Static<typeof CommandKindSchema>;
export type CommandAcceptedResponse = Static<typeof CommandAcceptedResponseSchema>;
export type SessionStatus = Static<typeof SessionStatusSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type StreamEventEnvelope = Static<typeof StreamEventEnvelopeSchema>;
export type ExtensionUiRequestEventPayload = Static<typeof ExtensionUiRequestEventPayloadSchema>;
export type StreamReadResponse = Static<typeof StreamReadResponseSchema>;
export type Presence = Static<typeof PresenceSchema>;
