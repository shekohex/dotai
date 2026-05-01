import { Type, type Static, type TSchema } from "typebox";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { ExecutorRuntimeStateSchema } from "../extensions/executor/status.js";
import { GitRuntimeStateSchema } from "../extensions/git-state.js";
import {
  PackageSourceSchema,
  RemoteResourceBundleSchema,
  RemoteSettingsSnapshotSchema,
} from "./schemas-settings.js";
import {
  ClientCapabilitiesSchema,
  ClientCapabilitiesPrimitivesSchema,
  ConnectionCapabilitiesParamsSchema,
  ConnectionCapabilitiesResponseSchema,
  RemoteExtensionMetadataSchema,
  RemoteExtensionRuntimeSchema,
} from "./schemas-capabilities.js";
import { RemoteCustomExtensionEventPayloadSchema } from "./event-bus-bridge.js";
import {
  ExtensionUiRequestEventPayloadSchema,
  JsonValueSchema,
  TranscriptAssistantMessageSchema,
  TranscriptMessageTransportSchema,
  TranscriptSchema,
} from "./schemas-session-runtime.js";
import {
  RemoteToolInfoSchema,
  SessionToolsResponseSchema,
  ToolDefinitionMetadataSchema,
} from "./schemas-tools.js";
export {
  ClientCapabilitiesPrimitivesSchema,
  ClientCapabilitiesSchema,
  ConnectionCapabilitiesParamsSchema,
  ConnectionCapabilitiesResponseSchema,
  RemoteExtensionMetadataSchema,
  RemoteExtensionRuntimeSchema,
} from "./schemas-capabilities.js";
export {
  PackageSourceSchema,
  RemotePromptResourceSchema,
  RemoteResourceBundleSchema,
  RemoteSettingsSnapshotSchema,
  RemoteSkillResourceSchema,
  RemoteThemeResourceSchema,
} from "./schemas-settings.js";
export { ExtensionUiRequestEventPayloadSchema } from "./schemas-session-runtime.js";
export {
  RemoteToolInfoSchema,
  SessionToolsResponseSchema,
  ToolDefinitionMetadataSchema,
} from "./schemas-tools.js";
export const SessionStatusSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("compacting"),
  Type.Literal("retrying"),
  Type.Literal("error"),
  Type.Literal("closed"),
]);
export const RuntimeTaskStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("running"),
  Type.Literal("interrupted"),
]);

export const StreamingStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("streaming"),
  Type.Literal("interrupted"),
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

export const PresenceSchema = Type.Object({
  clientId: Type.String(),
  deviceId: Type.Optional(Type.String()),
  connectionId: Type.String(),
  connectedAt: Type.Number(),
  lastSeenAt: Type.Number(),
  clientCapabilities: Type.Optional(ClientCapabilitiesSchema),
  lastSeenSessionOffset: Type.String(),
  lastSeenAppOffset: Type.String(),
});

export const SessionSummarySchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
  firstUserMessage: Type.Optional(Type.String()),
  messageCount: Type.Number(),
  status: SessionStatusSchema,
  cwd: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  parentSessionId: Type.Union([Type.String(), Type.Null()]),
  lifecycle: Type.Object({
    persistence: Type.Union([Type.Literal("persistent"), Type.Literal("ephemeral")]),
    loaded: Type.Boolean(),
    state: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  }),
  version: Type.String(),
});

export const SessionDeletedResponseSchema = Type.Object({
  sessionId: Type.String(),
  deleted: Type.Boolean(),
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
  compat: Type.Optional(JsonValueSchema),
});

export const RemoteModelSettingsSchema = Type.Object({
  defaultProvider: Type.Union([Type.String(), Type.Null()]),
  defaultModel: Type.Union([Type.String(), Type.Null()]),
  defaultThinkingLevel: Type.Union([Type.String(), Type.Null()]),
  enabledModels: Type.Union([Type.Array(Type.String()), Type.Null()]),
});

export const ContextUsageSchema = Type.Object({
  tokens: Type.Union([Type.Number(), Type.Null()]),
  contextWindow: Type.Number(),
  percent: Type.Union([Type.Number(), Type.Null()]),
});

export const SessionStatsSchema = Type.Object({
  sessionFile: Type.Optional(Type.String()),
  sessionId: Type.String(),
  userMessages: Type.Number(),
  assistantMessages: Type.Number(),
  toolCalls: Type.Number(),
  toolResults: Type.Number(),
  totalMessages: Type.Number(),
  tokens: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
  cost: Type.Number(),
  contextUsage: Type.Optional(ContextUsageSchema),
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
  workspaceCwd: Type.Optional(Type.String({ minLength: 1 })),
  persistence: Type.Optional(Type.Union([Type.Literal("persistent"), Type.Literal("ephemeral")])),
});

export const CreateSessionResponseSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
  status: SessionStatusSchema,
});

export const ForkPositionSchema = Type.Union([Type.Literal("before"), Type.Literal("at")]);

export const SessionForkMessageSchema = Type.Object({
  entryId: Type.String(),
  text: Type.String(),
});

export const SessionForkMessagesResponseSchema = Type.Object({
  messages: Type.Array(SessionForkMessageSchema),
});

const TextContentPartSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
});

const ImageContentPartSchema = Type.Object({
  type: Type.Literal("image"),
  mimeType: Type.String(),
  data: Type.String(),
});

const MessageContentPartSchema = Type.Union([TextContentPartSchema, ImageContentPartSchema]);

const MessageContentSchema = Type.Union([Type.String(), Type.Array(MessageContentPartSchema)]);

const SessionMessageEntrySchema = Type.Object({
  type: Type.Literal("message"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  message: TranscriptMessageTransportSchema,
});

const ThinkingLevelChangeEntrySchema = Type.Object({
  type: Type.Literal("thinking_level_change"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  thinkingLevel: Type.String(),
});

const ModelChangeEntrySchema = Type.Object({
  type: Type.Literal("model_change"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  provider: Type.String(),
  modelId: Type.String(),
});

const CompactionEntrySchema = Type.Object({
  type: Type.Literal("compaction"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  summary: Type.String(),
  firstKeptEntryId: Type.String(),
  tokensBefore: Type.Number(),
  details: Type.Optional(JsonValueSchema),
  fromHook: Type.Optional(Type.Boolean()),
});

const BranchSummaryEntrySchema = Type.Object({
  type: Type.Literal("branch_summary"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  fromId: Type.String(),
  summary: Type.String(),
  details: Type.Optional(JsonValueSchema),
  fromHook: Type.Optional(Type.Boolean()),
});

const CustomEntrySchema = Type.Object({
  type: Type.Literal("custom"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  customType: Type.String(),
  data: Type.Optional(JsonValueSchema),
});

const CustomMessageEntrySchema = Type.Object({
  type: Type.Literal("custom_message"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  customType: Type.String(),
  content: MessageContentSchema,
  details: Type.Optional(JsonValueSchema),
  display: Type.Boolean(),
});

const LabelEntrySchema = Type.Object({
  type: Type.Literal("label"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  targetId: Type.String(),
  label: Type.Optional(Type.String()),
});

const SessionInfoEntrySchema = Type.Object({
  type: Type.Literal("session_info"),
  id: Type.String(),
  parentId: Type.Union([Type.String(), Type.Null()]),
  timestamp: Type.String(),
  name: Type.Optional(Type.String()),
});

export const RemoteSessionEntrySchema = Type.Union([
  Type.Unsafe<Extract<SessionEntry, { type: "message" }>>(SessionMessageEntrySchema),
  Type.Unsafe<Extract<SessionEntry, { type: "thinking_level_change" }>>(
    ThinkingLevelChangeEntrySchema,
  ),
  Type.Unsafe<Extract<SessionEntry, { type: "model_change" }>>(ModelChangeEntrySchema),
  CompactionEntrySchema,
  BranchSummaryEntrySchema,
  CustomEntrySchema,
  CustomMessageEntrySchema,
  Type.Unsafe<Extract<SessionEntry, { type: "label" }>>(LabelEntrySchema),
  Type.Unsafe<Extract<SessionEntry, { type: "session_info" }>>(SessionInfoEntrySchema),
]);

export type RemoteSessionEntry = Static<typeof RemoteSessionEntrySchema>;

export const SessionEntrySchema = Type.Unsafe<SessionEntry>(RemoteSessionEntrySchema);

type EnsureTrue<T extends true> = T;
type KnownSessionEntryMembers =
  | Extract<SessionEntry, { type: "message" }>
  | Extract<SessionEntry, { type: "thinking_level_change" }>
  | Extract<SessionEntry, { type: "model_change" }>
  | Extract<SessionEntry, { type: "compaction" }>
  | Extract<SessionEntry, { type: "branch_summary" }>
  | Extract<SessionEntry, { type: "custom" }>
  | Extract<SessionEntry, { type: "custom_message" }>
  | Extract<SessionEntry, { type: "label" }>
  | Extract<SessionEntry, { type: "session_info" }>;
type AssertNoUnhandledSessionEntryMembers = EnsureTrue<
  Exclude<SessionEntry, KnownSessionEntryMembers> extends never ? true : false
>;
const sessionEntryMemberParity: AssertNoUnhandledSessionEntryMembers = true;
void sessionEntryMemberParity;

export const NavigateTreeRequestSchema = Type.Object({
  targetId: Type.String({ minLength: 1 }),
  summarize: Type.Optional(Type.Boolean()),
  customInstructions: Type.Optional(Type.String()),
  replaceInstructions: Type.Optional(Type.Boolean()),
  label: Type.Optional(Type.String()),
});

export const CompactRequestSchema = Type.Object({
  customInstructions: Type.Optional(Type.String()),
});

export const BashExecuteRequestSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  timeout: Type.Optional(Type.Number()),
  excludeFromContext: Type.Optional(Type.Boolean()),
  clientRequestId: Type.Optional(Type.String({ minLength: 1 })),
});

export const BashResultSchema = Type.Object({
  output: Type.String(),
  exitCode: Type.Optional(Type.Number()),
  cancelled: Type.Boolean(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
});

export const BashRecordRequestSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  result: Type.Object({
    output: Type.String(),
    exitCode: Type.Optional(Type.Number()),
    cancelled: Type.Boolean(),
    truncated: Type.Boolean(),
    fullOutputPath: Type.Optional(Type.String()),
  }),
  excludeFromContext: Type.Optional(Type.Boolean()),
});

export const AbortOperationResponseSchema = Type.Object({
  ok: Type.Boolean(),
});

export const ExtensionCustomEventRequestSchema = Type.Object({
  channel: Type.String({ minLength: 1 }),
  data: JsonValueSchema,
});

export const ForkSessionRequestSchema = Type.Object({
  entryId: Type.Optional(Type.String({ minLength: 1 })),
  position: Type.Optional(ForkPositionSchema),
  workspaceCwd: Type.Optional(Type.String({ minLength: 1 })),
});

export const ForkSessionResponseSchema = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.Optional(Type.String()),
  status: SessionStatusSchema,
  selectedText: Type.Optional(Type.String()),
});

export const SessionParamsSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
});

export const SessionSnapshotQuerySchema = Type.Object({
  entriesLimit: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  entriesOffset: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
});

export const SessionEntriesQuerySchema = Type.Object({
  entriesLimit: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  entriesOffset: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
});

export const SessionToolParamsSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  toolName: Type.String({ minLength: 1 }),
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

export const ActiveToolsUpdateRequestSchema = Type.Object({
  toolNames: Type.Array(Type.String({ minLength: 1 })),
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

const ThinkingLevelSettingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
]);

const TransportSettingSchema = Type.Union([
  Type.Literal("sse"),
  Type.Literal("websocket"),
  Type.Literal("auto"),
]);

const QueueModeSettingSchema = Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]);

const DoubleEscapeActionSettingSchema = Type.Union([
  Type.Literal("fork"),
  Type.Literal("tree"),
  Type.Literal("none"),
]);

const TreeFilterModeSettingSchema = Type.Union([
  Type.Literal("default"),
  Type.Literal("no-tools"),
  Type.Literal("user-only"),
  Type.Literal("labeled-only"),
  Type.Literal("all"),
]);

function settingsMutationSchema<
  const TMethod extends string,
  const TArgs extends readonly TSchema[],
>(method: TMethod, args: TArgs) {
  return Type.Object({
    method: Type.Literal(method),
    args: Type.Tuple([...args]),
    requestId: Type.Optional(Type.String({ minLength: 1 })),
  });
}

export type SettingsUpdateRequestValue =
  | { method: "setLastChangelogVersion"; args: [string]; requestId?: string }
  | { method: "setDefaultProvider"; args: [string]; requestId?: string }
  | { method: "setDefaultModel"; args: [string]; requestId?: string }
  | { method: "setDefaultModelAndProvider"; args: [string, string]; requestId?: string }
  | {
      method: "setDefaultThinkingLevel";
      args: ["off" | "minimal" | "low" | "medium" | "high" | "xhigh"];
      requestId?: string;
    }
  | { method: "setEnabledModels"; args: [string[] | null]; requestId?: string }
  | { method: "setSteeringMode"; args: ["all" | "one-at-a-time"]; requestId?: string }
  | { method: "setFollowUpMode"; args: ["all" | "one-at-a-time"]; requestId?: string }
  | { method: "setAutoCompactionEnabled"; args: [boolean]; requestId?: string }
  | { method: "setCompactionEnabled"; args: [boolean]; requestId?: string }
  | { method: "setTheme"; args: [string]; requestId?: string }
  | { method: "setTransport"; args: ["sse" | "websocket" | "auto"]; requestId?: string }
  | { method: "setRetryEnabled"; args: [boolean]; requestId?: string }
  | { method: "setHideThinkingBlock"; args: [boolean]; requestId?: string }
  | { method: "setShellPath"; args: [string | null]; requestId?: string }
  | { method: "setQuietStartup"; args: [boolean]; requestId?: string }
  | { method: "setShellCommandPrefix"; args: [string | null]; requestId?: string }
  | { method: "setNpmCommand"; args: [string[] | null]; requestId?: string }
  | { method: "setCollapseChangelog"; args: [boolean]; requestId?: string }
  | { method: "setEnableInstallTelemetry"; args: [boolean]; requestId?: string }
  | { method: "setPackages"; args: [Static<typeof PackageSourceSchema>[]]; requestId?: string }
  | {
      method: "setProjectPackages";
      args: [Static<typeof PackageSourceSchema>[]];
      requestId?: string;
    }
  | { method: "setExtensionPaths"; args: [string[]]; requestId?: string }
  | { method: "setProjectExtensionPaths"; args: [string[]]; requestId?: string }
  | { method: "setSkillPaths"; args: [string[]]; requestId?: string }
  | { method: "setProjectSkillPaths"; args: [string[]]; requestId?: string }
  | { method: "setPromptTemplatePaths"; args: [string[]]; requestId?: string }
  | { method: "setProjectPromptTemplatePaths"; args: [string[]]; requestId?: string }
  | { method: "setThemePaths"; args: [string[]]; requestId?: string }
  | { method: "setProjectThemePaths"; args: [string[]]; requestId?: string }
  | { method: "setEnableSkillCommands"; args: [boolean]; requestId?: string }
  | { method: "setShowImages"; args: [boolean]; requestId?: string }
  | { method: "setClearOnShrink"; args: [boolean]; requestId?: string }
  | { method: "setImageAutoResize"; args: [boolean]; requestId?: string }
  | { method: "setBlockImages"; args: [boolean]; requestId?: string }
  | { method: "setDoubleEscapeAction"; args: ["fork" | "tree" | "none"]; requestId?: string }
  | {
      method: "setTreeFilterMode";
      args: ["default" | "no-tools" | "user-only" | "labeled-only" | "all"];
      requestId?: string;
    }
  | { method: "setShowHardwareCursor"; args: [boolean]; requestId?: string }
  | { method: "setEditorPaddingX"; args: [number]; requestId?: string }
  | { method: "setAutocompleteMaxVisible"; args: [number]; requestId?: string };

export const SettingsUpdateRequestTransportSchema = Type.Union([
  settingsMutationSchema("setLastChangelogVersion", [Type.String()]),
  settingsMutationSchema("setDefaultProvider", [Type.String()]),
  settingsMutationSchema("setDefaultModel", [Type.String()]),
  settingsMutationSchema("setDefaultModelAndProvider", [Type.String(), Type.String()]),
  settingsMutationSchema("setDefaultThinkingLevel", [ThinkingLevelSettingSchema]),
  settingsMutationSchema("setEnabledModels", [
    Type.Union([Type.Array(Type.String()), Type.Null()]),
  ]),
  settingsMutationSchema("setSteeringMode", [QueueModeSettingSchema]),
  settingsMutationSchema("setFollowUpMode", [QueueModeSettingSchema]),
  settingsMutationSchema("setAutoCompactionEnabled", [Type.Boolean()]),
  settingsMutationSchema("setCompactionEnabled", [Type.Boolean()]),
  settingsMutationSchema("setTheme", [Type.String()]),
  settingsMutationSchema("setTransport", [TransportSettingSchema]),
  settingsMutationSchema("setRetryEnabled", [Type.Boolean()]),
  settingsMutationSchema("setHideThinkingBlock", [Type.Boolean()]),
  settingsMutationSchema("setShellPath", [Type.Union([Type.String(), Type.Null()])]),
  settingsMutationSchema("setQuietStartup", [Type.Boolean()]),
  settingsMutationSchema("setShellCommandPrefix", [Type.Union([Type.String(), Type.Null()])]),
  settingsMutationSchema("setNpmCommand", [Type.Union([Type.Array(Type.String()), Type.Null()])]),
  settingsMutationSchema("setCollapseChangelog", [Type.Boolean()]),
  settingsMutationSchema("setEnableInstallTelemetry", [Type.Boolean()]),
  settingsMutationSchema("setPackages", [Type.Array(PackageSourceSchema)]),
  settingsMutationSchema("setProjectPackages", [Type.Array(PackageSourceSchema)]),
  settingsMutationSchema("setExtensionPaths", [Type.Array(Type.String())]),
  settingsMutationSchema("setProjectExtensionPaths", [Type.Array(Type.String())]),
  settingsMutationSchema("setSkillPaths", [Type.Array(Type.String())]),
  settingsMutationSchema("setProjectSkillPaths", [Type.Array(Type.String())]),
  settingsMutationSchema("setPromptTemplatePaths", [Type.Array(Type.String())]),
  settingsMutationSchema("setProjectPromptTemplatePaths", [Type.Array(Type.String())]),
  settingsMutationSchema("setThemePaths", [Type.Array(Type.String())]),
  settingsMutationSchema("setProjectThemePaths", [Type.Array(Type.String())]),
  settingsMutationSchema("setEnableSkillCommands", [Type.Boolean()]),
  settingsMutationSchema("setShowImages", [Type.Boolean()]),
  settingsMutationSchema("setClearOnShrink", [Type.Boolean()]),
  settingsMutationSchema("setImageAutoResize", [Type.Boolean()]),
  settingsMutationSchema("setBlockImages", [Type.Boolean()]),
  settingsMutationSchema("setDoubleEscapeAction", [DoubleEscapeActionSettingSchema]),
  settingsMutationSchema("setTreeFilterMode", [TreeFilterModeSettingSchema]),
  settingsMutationSchema("setShowHardwareCursor", [Type.Boolean()]),
  settingsMutationSchema("setEditorPaddingX", [Type.Number()]),
  settingsMutationSchema("setAutocompleteMaxVisible", [Type.Number()]),
]);

export const SettingsUpdateRequestSchema = Type.Unsafe<SettingsUpdateRequestValue>(
  SettingsUpdateRequestTransportSchema,
);

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
  Type.Literal("active-tools"),
  Type.Literal("model"),
  Type.Literal("session-name"),
  Type.Literal("settings"),
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
  sessionName: Type.Optional(Type.String()),
  status: SessionStatusSchema,
  cwd: Type.String(),
  model: Type.String(),
  thinkingLevel: Type.String(),
  activeTools: Type.Array(Type.String()),
  extensions: Type.Array(RemoteExtensionMetadataSchema),
  resources: Type.Optional(RemoteResourceBundleSchema),
  settings: Type.Optional(RemoteSettingsSnapshotSchema),
  availableModels: Type.Array(RemoteModelSchema),
  modelSettings: RemoteModelSettingsSchema,
  sessionStats: SessionStatsSchema,
  contextUsage: Type.Optional(ContextUsageSchema),
  usageCost: Type.Number(),
  autoCompactionEnabled: Type.Boolean(),
  steeringMode: Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]),
  followUpMode: Type.Union([Type.Literal("all"), Type.Literal("one-at-a-time")]),
  executorState: Type.Optional(ExecutorRuntimeStateSchema),
  gitState: Type.Optional(GitRuntimeStateSchema),
  entries: Type.Array(SessionEntrySchema),
  leafId: Type.Union([Type.String(), Type.Null()]),
  transcript: TranscriptSchema,
  queue: Type.Object({
    depth: Type.Number(),
    nextSequence: Type.Number(),
  }),
  live: Type.Object({
    queuedSteeringMessages: Type.Array(Type.String()),
    queuedFollowUpMessages: Type.Array(Type.String()),
    retryAttempt: Type.Number(),
    streamingMessage: Type.Optional(TranscriptAssistantMessageSchema),
    activeToolExecutions: Type.Array(
      Type.Object({
        toolCallId: Type.String(),
        toolName: Type.String(),
        args: JsonValueSchema,
        partialResult: Type.Optional(JsonValueSchema),
      }),
    ),
  }),
  retry: Type.Object({
    status: RuntimeTaskStatusSchema,
  }),
  compaction: Type.Object({
    status: RuntimeTaskStatusSchema,
  }),
  presence: Type.Array(PresenceSchema),
  activeRun: Type.Union([
    Type.Null(),
    Type.Object({
      runId: Type.String(),
      status: Type.Union([SessionStatusSchema, Type.Literal("interrupted")]),
      triggeringCommandId: Type.String(),
      startedAt: Type.Number(),
      updatedAt: Type.Number(),
      pendingUiRequestId: Type.Optional(Type.String()),
      queueDepth: Type.Number(),
    }),
  ]),
  interruptedRuntimeDomains: Type.Object({
    queue: Type.Boolean(),
    retry: Type.Boolean(),
    compaction: Type.Boolean(),
    bash: Type.Boolean(),
    streaming: Type.Boolean(),
  }),
  pendingUiRequests: Type.Array(ExtensionUiRequestEventPayloadSchema),
  uiState: Type.Object({
    statuses: Type.Array(
      Type.Object({
        statusKey: Type.String(),
        statusText: Type.Optional(Type.String()),
      }),
    ),
    widgets: Type.Array(
      Type.Object({
        widgetKey: Type.String(),
        widgetLines: Type.Optional(Type.Array(Type.String())),
        widgetPlacement: Type.Optional(
          Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")]),
        ),
      }),
    ),
    workingMessage: Type.Optional(Type.String()),
    hiddenThinkingLabel: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    toolsExpanded: Type.Optional(Type.Boolean()),
    editorText: Type.Optional(Type.String()),
  }),
  durableExtensionState: Type.Array(RemoteCustomExtensionEventPayloadSchema),
  version: Type.String(),
  streamingState: StreamingStateSchema,
  isBashRunning: Type.Boolean(),
  hasPendingBashMessages: Type.Boolean(),
  pendingToolCalls: Type.Array(Type.String()),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});

export const SessionEntriesResponseSchema = Type.Object({
  entries: Type.Array(SessionEntrySchema),
  transcript: TranscriptSchema,
  totalEntries: Type.Number(),
  totalTranscriptMessages: Type.Number(),
  entriesLimit: Type.Number(),
  entriesOffset: Type.Number(),
});

export const NavigateTreeResponseSchema = Type.Object({
  editorText: Type.Optional(Type.String()),
  cancelled: Type.Boolean(),
  aborted: Type.Optional(Type.Boolean()),
  summaryEntry: Type.Optional(BranchSummaryEntrySchema),
  snapshot: Type.Optional(SessionSnapshotSchema),
});

export const CompactResponseSchema = Type.Object({
  summary: Type.String(),
  firstKeptEntryId: Type.String(),
  tokensBefore: Type.Number(),
  details: Type.Optional(JsonValueSchema),
  snapshot: Type.Optional(Type.Unknown()),
});

export const BashExecuteResponseSchema = Type.Object({
  ...BashResultSchema.properties,
  chunks: Type.Optional(Type.Array(Type.String())),
  clientRequestId: Type.Optional(Type.String()),
  snapshot: Type.Optional(Type.Unknown()),
});

export const BashRecordResponseSchema = Type.Object({
  snapshot: Type.Optional(Type.Unknown()),
});
