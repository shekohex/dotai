import type { Static } from "typebox";
import {
  AppSnapshotSchema,
  ActiveToolsUpdateRequestSchema,
  AuthChallengeRequestSchema,
  AuthChallengeResponseSchema,
  AuthVerifyRequestSchema,
  AuthVerifyResponseSchema,
  ClientCapabilitiesSchema,
  ClearQueueResponseSchema,
  CommandAcceptedResponseSchema,
  CommandKindSchema,
  ConnectionCapabilitiesResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  FollowUpCommandRequestSchema,
  InterruptCommandRequestSchema,
  ModelUpdateRequestSchema,
  PresenceSchema,
  PromptCommandRequestSchema,
  RemoteExtensionMetadataSchema,
  RemoteExtensionRuntimeSchema,
  RemoteResourceBundleSchema,
  RemoteSettingsSnapshotSchema,
  SessionNameUpdateRequestSchema,
  SessionDeletedResponseSchema,
  SessionSnapshotSchema,
  SessionToolsResponseSchema,
  SessionStatusSchema,
  SessionSummarySchema,
  SteerCommandRequestSchema,
  UiResponseRequestSchema,
  UiResponseResponseSchema,
  type SettingsUpdateRequestValue,
} from "./schemas-core.js";
import {
  RemoteKvDeleteResponseSchema,
  RemoteKvItemParamsSchema,
  RemoteKvReadResponseSchema,
  RemoteKvScopeSchema,
  RemoteKvWriteRequestSchema,
  RemoteKvWriteResponseSchema,
} from "./kv/schemas.js";
import {
  ExtensionUiResolvedEventPayloadSchema,
  ExtensionUiRequestEventPayloadSchema,
  StreamEventEnvelopeSchema,
  StreamReadResponseSchema,
} from "./schemas-stream.js";

export type AuthChallengeRequest = Static<typeof AuthChallengeRequestSchema>;
export type AuthChallengeResponse = Static<typeof AuthChallengeResponseSchema>;
export type AuthVerifyRequest = Static<typeof AuthVerifyRequestSchema>;
export type AuthVerifyResponse = Static<typeof AuthVerifyResponseSchema>;
export type ClientCapabilities = Static<typeof ClientCapabilitiesSchema>;
export type AppSnapshot = Static<typeof AppSnapshotSchema>;
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = Static<typeof CreateSessionResponseSchema>;
export type ConnectionCapabilitiesResponse = Static<typeof ConnectionCapabilitiesResponseSchema>;
export type PromptCommandRequest = Static<typeof PromptCommandRequestSchema>;
export type SteerCommandRequest = Static<typeof SteerCommandRequestSchema>;
export type FollowUpCommandRequest = Static<typeof FollowUpCommandRequestSchema>;
export type InterruptCommandRequest = Static<typeof InterruptCommandRequestSchema>;
export type ActiveToolsUpdateRequest = Static<typeof ActiveToolsUpdateRequestSchema>;
export type ModelUpdateRequest = Static<typeof ModelUpdateRequestSchema>;
export type SessionNameUpdateRequest = Static<typeof SessionNameUpdateRequestSchema>;
export type SettingsUpdateRequest = SettingsUpdateRequestValue;
export type SessionToolsResponse = Static<typeof SessionToolsResponseSchema>;
export type UiResponseRequest = Static<typeof UiResponseRequestSchema>;
export type UiResponseResponse = Static<typeof UiResponseResponseSchema>;
export type RemoteKvScope = Static<typeof RemoteKvScopeSchema>;
export type RemoteKvItemParams = Static<typeof RemoteKvItemParamsSchema>;
export type RemoteKvWriteRequest = Static<typeof RemoteKvWriteRequestSchema>;
export type RemoteKvReadResponse = Static<typeof RemoteKvReadResponseSchema>;
export type RemoteKvWriteResponse = Static<typeof RemoteKvWriteResponseSchema>;
export type RemoteKvDeleteResponse = Static<typeof RemoteKvDeleteResponseSchema>;
export type ClearQueueResponse = Static<typeof ClearQueueResponseSchema>;
export type CommandKind = Static<typeof CommandKindSchema>;
export type CommandAcceptedResponse = Static<typeof CommandAcceptedResponseSchema>;
export type SessionStatus = Static<typeof SessionStatusSchema>;
export type SessionDeletedResponse = Static<typeof SessionDeletedResponseSchema>;
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type StreamEventEnvelope = Static<typeof StreamEventEnvelopeSchema>;
export type ExtensionUiRequestEventPayload = Static<typeof ExtensionUiRequestEventPayloadSchema>;
export type ExtensionUiResolvedEventPayload = Static<typeof ExtensionUiResolvedEventPayloadSchema>;
export type StreamReadResponse = Static<typeof StreamReadResponseSchema>;
export type Presence = Static<typeof PresenceSchema>;
export type RemoteExtensionMetadata = Static<typeof RemoteExtensionMetadataSchema>;
export type RemoteExtensionRuntime = Static<typeof RemoteExtensionRuntimeSchema>;
export type RemoteResourceBundle = Static<typeof RemoteResourceBundleSchema>;
export type RemoteSettingsSnapshot = Static<typeof RemoteSettingsSnapshotSchema>;
