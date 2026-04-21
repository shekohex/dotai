import type { Static } from "@sinclair/typebox";
import {
  AppSnapshotSchema,
  AuthChallengeRequestSchema,
  AuthChallengeResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  ClearQueueResponseSchema,
  CommandAcceptedResponseSchema,
  CommandKindSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  DraftUpdateRequestSchema,
  FollowUpCommandRequestSchema,
  InterruptCommandRequestSchema,
  ModelUpdateRequestSchema,
  PresenceSchema,
  PromptCommandRequestSchema,
  RemoteExtensionHostSchema,
  RemoteExtensionMetadataSchema,
  SessionNameUpdateRequestSchema,
  SessionSnapshotSchema,
  SessionStatusSchema,
  SessionSummarySchema,
  SteerCommandRequestSchema,
  UiResponseRequestSchema,
  UiResponseResponseSchema,
} from "./schemas-core.js";
import {
  ExtensionUiRequestEventPayloadSchema,
  StreamEventEnvelopeSchema,
  StreamReadResponseSchema,
} from "./schemas-stream.js";

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
export type RemoteExtensionMetadata = Static<typeof RemoteExtensionMetadataSchema>;
export type RemoteExtensionHost = Static<typeof RemoteExtensionHostSchema>;
