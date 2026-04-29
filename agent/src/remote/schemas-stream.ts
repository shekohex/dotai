import { Type } from "typebox";
import {
  BashResultSchema,
  CommandKindSchema,
  ContextUsageSchema,
  PresenceSchema,
  RemoteExtensionMetadataSchema,
  RemoteResourceBundleSchema,
  RemoteSettingsSnapshotSchema,
  RemoteModelSchema,
  RemoteModelSettingsSchema,
  SessionStatsSchema,
  SessionStatusSchema,
  SessionSnapshotSchema,
  UiResponseRequestSchema,
} from "./schemas-core.js";
import { RemoteCustomExtensionEventPayloadSchema } from "./event-bus-bridge.js";

const WorkingIndicatorOptionsSchema = Type.Object({
  frames: Type.Optional(Type.Array(Type.String())),
  intervalMs: Type.Optional(Type.Number()),
});

const StreamEventCommonProperties = {
  eventId: Type.String(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  streamOffset: Type.String(),
  ts: Type.Number(),
};

const SessionCreatedEventPayloadSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
  status: SessionStatusSchema,
});

const SessionClosedEventPayloadSchema = Type.Object({
  sessionId: Type.String(),
});

const SessionSummaryUpdatedEventPayloadSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
  status: SessionStatusSchema,
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

const ExtensionEventPayloadSchema = Type.Object(
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

const SessionStatePatchEventPayloadSchema = Type.Object({
  commandId: Type.String(),
  sequence: Type.Number(),
  patch: Type.Object(
    {
      model: Type.Optional(Type.String()),
      thinkingLevel: Type.Optional(Type.String()),
      sessionName: Type.Optional(Type.String()),
      activeTools: Type.Optional(Type.Array(Type.String())),
      cwd: Type.Optional(Type.String()),
      extensions: Type.Optional(Type.Array(RemoteExtensionMetadataSchema)),
      resources: Type.Optional(RemoteResourceBundleSchema),
      settings: Type.Optional(RemoteSettingsSnapshotSchema),
      availableModels: Type.Optional(Type.Array(RemoteModelSchema)),
      modelSettings: Type.Optional(RemoteModelSettingsSchema),
      sessionStats: Type.Optional(SessionStatsSchema),
      contextUsage: Type.Optional(ContextUsageSchema),
      usageCost: Type.Optional(Type.Number()),
      isBashRunning: Type.Optional(Type.Boolean()),
      hasPendingBashMessages: Type.Optional(Type.Boolean()),
      autoCompactionEnabled: Type.Optional(Type.Boolean()),
      steeringMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
      followUpMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")])),
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
    method: Type.Literal("setWorkingIndicator"),
    options: Type.Optional(WorkingIndicatorOptionsSchema),
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
    method: Type.Literal("setToolsExpanded"),
    expanded: Type.Boolean(),
  }),
  Type.Object({
    id: Type.String({ minLength: 1 }),
    method: Type.Literal("set_editor_text"),
    text: Type.String(),
  }),
]);

export const ExtensionUiResolvedEventPayloadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  resolvedAt: Type.Number(),
  resolvedByClientId: Type.String(),
  resolvedByConnectionId: Type.String(),
  response: UiResponseRequestSchema,
});

const ExtensionErrorEventPayloadSchema = Type.Object({
  commandId: Type.String(),
  kind: CommandKindSchema,
  error: Type.String(),
});

const BashStartEventPayloadSchema = Type.Object({
  executionId: Type.String({ minLength: 1 }),
  command: Type.String({ minLength: 1 }),
  clientRequestId: Type.Optional(Type.String({ minLength: 1 })),
  excludeFromContext: Type.Optional(Type.Boolean()),
});

const BashChunkEventPayloadSchema = Type.Object({
  executionId: Type.String({ minLength: 1 }),
  chunk: Type.String(),
  clientRequestId: Type.Optional(Type.String({ minLength: 1 })),
});

const BashExecutionMessagePayloadSchema = Type.Object({
  role: Type.Literal("bashExecution"),
  command: Type.String(),
  output: Type.String(),
  exitCode: Type.Optional(Type.Number()),
  cancelled: Type.Boolean(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  timestamp: Type.Number(),
  excludeFromContext: Type.Optional(Type.Boolean()),
});

const BashEndEventPayloadSchema = Type.Object({
  executionId: Type.String({ minLength: 1 }),
  clientRequestId: Type.Optional(Type.String({ minLength: 1 })),
  result: BashResultSchema,
  deferredUntilTurnEnd: Type.Boolean(),
  message: Type.Optional(BashExecutionMessagePayloadSchema),
});

const BashFlushEventPayloadSchema = Type.Object({
  messages: Type.Array(BashExecutionMessagePayloadSchema),
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
    kind: Type.Literal("extension_event"),
    payload: ExtensionEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("extension_custom_event"),
    payload: RemoteCustomExtensionEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("command_accepted"),
    payload: CommandAcceptedEventPayloadSchema,
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
    kind: Type.Literal("extension_ui_resolved"),
    payload: ExtensionUiResolvedEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("extension_error"),
    payload: ExtensionErrorEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("bash_start"),
    payload: BashStartEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("bash_chunk"),
    payload: BashChunkEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("bash_end"),
    payload: BashEndEventPayloadSchema,
  }),
  Type.Object({
    ...StreamEventCommonProperties,
    kind: Type.Literal("bash_flush"),
    payload: BashFlushEventPayloadSchema,
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

export const SessionSyncConnectedEventSchema = Type.Object({
  type: Type.Literal("server.connected"),
  sessionId: Type.String(),
});

export const SessionSyncSnapshotEventSchema = Type.Object({
  type: Type.Literal("snapshot"),
  sessionId: Type.String(),
  version: Type.String(),
  snapshot: SessionSnapshotSchema,
});

export const SessionSyncPatchEventSchema = Type.Object({
  type: Type.Literal("patch"),
  sessionId: Type.String(),
  version: Type.String(),
  event: StreamEventEnvelopeSchema,
});

export const SessionSyncEventSchema = Type.Union([
  SessionSyncConnectedEventSchema,
  SessionSyncSnapshotEventSchema,
  SessionSyncPatchEventSchema,
]);
