import { Type, type Static, type TSchema } from "typebox";
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
  sessionName: Type.String(),
  status: SessionStatusSchema,
  cwd: Type.String(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  parentSessionId: Type.Union([Type.String(), Type.Null()]),
  lifecycle: Type.Object({
    persistence: Type.Union([Type.Literal("persistent"), Type.Literal("ephemeral")]),
    loaded: Type.Boolean(),
    state: Type.Literal("active"),
  }),
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

type PackageSourceValue = Static<typeof PackageSourceSchema>;

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
  | { method: "setPackages"; args: [PackageSourceValue[]]; requestId?: string }
  | { method: "setProjectPackages"; args: [PackageSourceValue[]]; requestId?: string }
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

export const SettingsUpdateRequestSchema = Type.Unsafe<SettingsUpdateRequestValue>(
  Type.Union([
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
  ]),
);

export const RemoteToolInfoSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  parameters: Type.Unknown(),
  sourceInfo: Type.Unknown(),
});

export const SessionToolsResponseSchema = Type.Object({
  tools: Type.Array(RemoteToolInfoSchema),
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
  sessionName: Type.String(),
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
