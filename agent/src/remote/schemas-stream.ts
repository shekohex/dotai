import { Type } from "typebox";
import { JsonValueSchema } from "./json-schema.js";
import {
  BashResultSchema,
  CommandKindSchema,
  ContextUsageSchema,
  ExtensionUiRequestEventPayloadSchema,
  PresenceSchema,
  RemoteExtensionMetadataSchema,
  RemoteResourceBundleSchema,
  RemoteSettingsSnapshotSchema,
  RemoteModelSchema,
  RemoteModelSettingsSchema,
  SessionStatsSchema,
  SessionStatusSchema,
  SessionSnapshotSchema,
  FollowUpCommandRequestSchema,
  InterruptCommandRequestSchema,
  PromptCommandRequestSchema,
  SessionNameUpdateRequestSchema,
  SteerCommandRequestSchema,
  ActiveToolsUpdateRequestSchema,
  ModelUpdateRequestSchema,
  SettingsUpdateRequestSchema,
  UiResponseRequestSchema,
} from "./schemas-core.js";
import { TranscriptMessageTransportSchema } from "./schemas-session-runtime.js";
import { RemoteCustomExtensionEventPayloadSchema } from "./event-bus-bridge.js";

const StreamEventCommonProperties = {
  eventId: Type.String(),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  streamOffset: Type.String(),
  sessionVersion: Type.Optional(Type.String()),
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

export const RuntimeAssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(
    Type.Union([
      Type.Object({
        type: Type.Literal("text"),
        text: Type.String(),
        textSignature: Type.Optional(Type.String()),
      }),
      Type.Object({
        type: Type.Literal("thinking"),
        thinking: Type.String(),
        thinkingSignature: Type.Optional(Type.String()),
        redacted: Type.Optional(Type.Boolean()),
      }),
      Type.Object({
        type: Type.Literal("toolCall"),
        id: Type.String(),
        name: Type.String(),
        arguments: Type.Record(Type.String(), JsonValueSchema),
        thoughtSignature: Type.Optional(Type.String()),
      }),
    ]),
  ),
  api: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  responseId: Type.Optional(Type.String()),
  usage: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    totalTokens: Type.Number(),
    cost: Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
      total: Type.Number(),
    }),
  }),
  stopReason: Type.Union([
    Type.Literal("stop"),
    Type.Literal("length"),
    Type.Literal("toolUse"),
    Type.Literal("error"),
    Type.Literal("aborted"),
  ]),
  errorMessage: Type.Optional(Type.String()),
  timestamp: Type.Number(),
});

export const AssistantMessageEventPayloadSchema = Type.Union([
  Type.Object({
    type: Type.Literal("start"),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("text_start"),
    contentIndex: Type.Number(),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("text_delta"),
    contentIndex: Type.Number(),
    delta: Type.String(),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("text_end"),
    contentIndex: Type.Number(),
    content: Type.String(),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("thinking_start"),
    contentIndex: Type.Number(),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("thinking_delta"),
    contentIndex: Type.Number(),
    delta: Type.String(),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("thinking_end"),
    contentIndex: Type.Number(),
    content: Type.String(),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("toolcall_start"),
    contentIndex: Type.Number(),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("toolcall_delta"),
    contentIndex: Type.Number(),
    delta: Type.String(),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("toolcall_end"),
    contentIndex: Type.Number(),
    toolCall: Type.Object({
      type: Type.Literal("toolCall"),
      id: Type.String(),
      name: Type.String(),
      arguments: Type.Record(Type.String(), JsonValueSchema),
      thoughtSignature: Type.Optional(Type.String()),
    }),
    partial: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("done"),
    reason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
    message: RuntimeAssistantMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("error"),
    reason: Type.Union([Type.Literal("aborted"), Type.Literal("error")]),
    error: RuntimeAssistantMessageSchema,
  }),
]);

export const AssistantMessageSyncPatchPayloadSchema = Type.Object({
  type: Type.Literal("message_update"),
  message: RuntimeAssistantMessageSchema,
  assistantMessageEvent: AssistantMessageEventPayloadSchema,
});

export const AgentSessionMessageSchema = Type.Union([
  TranscriptMessageTransportSchema,
  RuntimeAssistantMessageSchema,
]);

export const ToolExecutionSyncPatchPayloadSchema = Type.Union([
  Type.Object({
    type: Type.Literal("tool_execution_start"),
    toolCallId: Type.String(),
    toolName: Type.String(),
    args: JsonValueSchema,
  }),
  Type.Object({
    type: Type.Literal("tool_execution_update"),
    toolCallId: Type.String(),
    toolName: Type.String(),
    args: JsonValueSchema,
    partialResult: JsonValueSchema,
  }),
  Type.Object({
    type: Type.Literal("tool_execution_end"),
    toolCallId: Type.String(),
    toolName: Type.String(),
    result: JsonValueSchema,
    isError: Type.Boolean(),
  }),
]);

export const QueueUpdateSyncPatchPayloadSchema = Type.Object({
  type: Type.Literal("queue_update"),
  steering: Type.Array(Type.String()),
  followUp: Type.Array(Type.String()),
});

export const RetryStatusSyncPatchPayloadSchema = Type.Union([
  Type.Object({
    type: Type.Literal("auto_retry_start"),
    attempt: Type.Number(),
    maxAttempts: Type.Number(),
    delayMs: Type.Number(),
    errorMessage: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("auto_retry_end"),
    success: Type.Boolean(),
    attempt: Type.Number(),
    finalError: Type.Optional(Type.String()),
  }),
]);

export const CompactionStatusSyncPatchPayloadSchema = Type.Union([
  Type.Object({
    type: Type.Literal("compaction_start"),
    reason: Type.Union([
      Type.Literal("manual"),
      Type.Literal("threshold"),
      Type.Literal("overflow"),
    ]),
  }),
  Type.Object({
    type: Type.Literal("compaction_end"),
    reason: Type.Union([
      Type.Literal("manual"),
      Type.Literal("threshold"),
      Type.Literal("overflow"),
    ]),
    result: Type.Optional(JsonValueSchema),
    aborted: Type.Boolean(),
    willRetry: Type.Boolean(),
    errorMessage: Type.Optional(Type.String()),
  }),
]);

export const AgentLifecycleEventPayloadSchema = Type.Union([
  Type.Object({ type: Type.Literal("agent_start") }),
  Type.Object({
    type: Type.Literal("turn_start"),
    turnIndex: Type.Optional(Type.Number()),
    timestamp: Type.Optional(Type.Number()),
  }),
  Type.Object({
    type: Type.Literal("agent_end"),
    messages: Type.Array(AgentSessionMessageSchema),
  }),
  Type.Object({
    type: Type.Literal("turn_end"),
    turnIndex: Type.Optional(Type.Number()),
    message: AgentSessionMessageSchema,
    toolResults: Type.Array(TranscriptMessageTransportSchema),
  }),
  Type.Object({
    type: Type.Literal("message_start"),
    message: AgentSessionMessageSchema,
  }),
  Type.Object({
    type: Type.Literal("message_end"),
    message: AgentSessionMessageSchema,
  }),
]);

const AgentSessionGenericFallbackPayloadSchema = Type.Object(
  {
    type: Type.String(),
  },
  { additionalProperties: true },
);

const AgentSessionEventKnownPayloadSchema = Type.Union([
  AgentLifecycleEventPayloadSchema,
  Type.Object({
    type: Type.Literal("message_update"),
    message: RuntimeAssistantMessageSchema,
    assistantMessageEvent: AssistantMessageEventPayloadSchema,
  }),
  ToolExecutionSyncPatchPayloadSchema,
  QueueUpdateSyncPatchPayloadSchema,
  RetryStatusSyncPatchPayloadSchema,
  CompactionStatusSyncPatchPayloadSchema,
]);

const AgentSessionEventPayloadSchema = Type.Union([
  AgentSessionEventKnownPayloadSchema,
  AgentSessionGenericFallbackPayloadSchema,
]);

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
  payload: Type.Union([
    PromptCommandRequestSchema,
    SteerCommandRequestSchema,
    FollowUpCommandRequestSchema,
    InterruptCommandRequestSchema,
    ActiveToolsUpdateRequestSchema,
    ModelUpdateRequestSchema,
    SessionNameUpdateRequestSchema,
    SettingsUpdateRequestSchema,
  ]),
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

export const SessionSyncPatchPayloadSchema = Type.Union([
  Type.Object({
    patchType: Type.Literal("session.state"),
    payload: SessionStatePatchEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("assistant.message"),
    payload: AssistantMessageSyncPatchPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("tool.execution"),
    payload: ToolExecutionSyncPatchPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("queue.update"),
    payload: QueueUpdateSyncPatchPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("retry.status"),
    payload: RetryStatusSyncPatchPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("compaction.status"),
    payload: CompactionStatusSyncPatchPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("agent.lifecycle"),
    payload: AgentLifecycleEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("agent.event"),
    eventType: Type.String(),
    payload: AgentSessionGenericFallbackPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("extension.custom"),
    payload: RemoteCustomExtensionEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("extension.event"),
    payload: ExtensionEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("extension.ui.request"),
    payload: ExtensionUiRequestEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("extension.ui.resolved"),
    payload: ExtensionUiResolvedEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("command.accepted"),
    payload: CommandAcceptedEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("bash.start"),
    payload: BashStartEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("bash.chunk"),
    payload: BashChunkEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("bash.end"),
    payload: BashEndEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("bash.flush"),
    payload: BashFlushEventPayloadSchema,
  }),
  Type.Object({
    patchType: Type.Literal("extension.error"),
    payload: ExtensionErrorEventPayloadSchema,
  }),
]);

export const SessionSyncPatchEventSchema = Type.Object({
  type: Type.Literal("patch"),
  sessionId: Type.String(),
  version: Type.String(),
  patch: SessionSyncPatchPayloadSchema,
});

export const SessionSyncEventSchema = Type.Union([
  SessionSyncConnectedEventSchema,
  SessionSyncSnapshotEventSchema,
  SessionSyncPatchEventSchema,
]);
