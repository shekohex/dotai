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

export const SessionSnapshotSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  status: SessionStatusSchema,
  model: Type.String(),
  thinkingLevel: Type.String(),
  activeTools: Type.Array(Type.String()),
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

export const StreamEventEnvelopeSchema = Type.Object({
  eventId: Type.String(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  streamOffset: Type.String(),
  ts: Type.Number(),
  kind: Type.String(),
  payload: Type.Unknown(),
});

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
export type SessionStatus = Static<typeof SessionStatusSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type StreamEventEnvelope = Static<typeof StreamEventEnvelopeSchema>;
export type StreamReadResponse = Static<typeof StreamReadResponseSchema>;
export type Presence = Static<typeof PresenceSchema>;
