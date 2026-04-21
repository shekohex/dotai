import { Type } from "@sinclair/typebox";

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

export const RemoteExtensionHostSchema = Type.Union([
  Type.Literal("server-bound"),
  Type.Literal("ui-only"),
]);

export const RemoteExtensionMetadataSchema = Type.Object({
  id: Type.String(),
  host: RemoteExtensionHostSchema,
  path: Type.String(),
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
  cwd: Type.String(),
  model: Type.String(),
  thinkingLevel: Type.String(),
  activeTools: Type.Array(Type.String()),
  extensions: Type.Array(RemoteExtensionMetadataSchema),
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
