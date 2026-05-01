import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AgentSessionRuntime,
  ContextUsage,
  ExtensionUIContext,
  SessionStats,
} from "@mariozechner/pi-coding-agent";
import { defaultSettings } from "../../default-settings.js";
import type { AuthSession } from "../auth.js";
import type { SessionCatalog } from "../session-catalog.js";
import type { RemoteRuntimeFactory } from "../runtime-factory.js";
import type {
  ActiveToolsUpdateRequest,
  CommandKind,
  CreateSessionRequest,
  ExtensionUiRequestEventPayload,
  FollowUpCommandRequest,
  InterruptCommandRequest,
  ModelUpdateRequest,
  Presence,
  PromptCommandRequest,
  RemoteExtensionMetadata,
  RemoteResourceBundle,
  RemoteSettingsSnapshot,
  SessionNameUpdateRequest,
  SessionSnapshot,
  SessionStatus,
  SettingsUpdateRequest,
  SteerCommandRequest,
  UiResponseRequest,
} from "../schemas.js";
import type { JsonValue } from "../json-schema.js";
import type { InMemoryDurableStreamStore } from "../streams.js";

export type RemoteUiInputHandlers = Pick<
  ExtensionUIContext,
  "select" | "confirm" | "input" | "editor" | "custom"
>;

export type RemoteUiStatusHandlers = Pick<
  ExtensionUIContext,
  | "notify"
  | "onTerminalInput"
  | "setStatus"
  | "setWorkingMessage"
  | "setWorkingIndicator"
  | "setHiddenThinkingLabel"
  | "setWidget"
  | "setTitle"
  | "getToolsExpanded"
  | "setToolsExpanded"
>;

export interface SessionRecord {
  sessionId: string;
  sessionName?: string;
  persistence: "persistent" | "ephemeral";
  status: SessionStatus;
  cwd: string;
  model: string;
  thinkingLevel: string;
  activeTools: string[];
  extensions: RemoteExtensionMetadata[];
  resources: RemoteResourceBundle;
  settings: RemoteSettingsSnapshot;
  availableModels: Model<Api>[];
  modelSettings: {
    defaultProvider: string | null;
    defaultModel: string | null;
    defaultThinkingLevel: string | null;
    enabledModels: string[] | null;
  };
  contextUsage: ContextUsage | undefined;
  usageCost: number;
  sessionStats: SessionStats;
  autoCompactionEnabled: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  transcript: AgentMessage[];
  queue: {
    depth: number;
    nextSequence: number;
  };
  live: {
    queuedSteeringMessages: string[];
    queuedFollowUpMessages: string[];
    retryAttempt: number;
    streamingMessage: Extract<AgentMessage, { role: "assistant" }> | undefined;
    activeToolExecutions: Map<
      string,
      {
        toolCallId: string;
        toolName: string;
        args: JsonValue;
        partialResult?: JsonValue;
      }
    >;
  };
  retry: {
    status: "idle" | "running" | "interrupted";
  };
  compaction: {
    status: "idle" | "running" | "interrupted";
  };
  activeRun: SessionSnapshot["activeRun"];
  streamingState: "idle" | "streaming" | "interrupted";
  isBashRunning: boolean;
  hasPendingBashMessages: boolean;
  pendingToolCalls: string[];
  lastDurableSessionVersion: number;
  interruptedRuntimeDomains: {
    queue: boolean;
    retry: boolean;
    compaction: boolean;
    bash: boolean;
    streaming: boolean;
  };
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  lastAppStreamOffsetSeenByServer: string;
  presence: Map<string, Presence>;
  runtime: AgentSessionRuntime;
  runtimeSubscription?: () => void;
  commandAcceptanceQueue: Promise<void>;
  runtimeDispatchQueue: Promise<void>;
  runtimeUndispatchedCommandCount: number;
  hasLocalCommandError: boolean;
  pendingUiRequests: Map<
    string,
    { resolve: (value: UiResponseRequest) => void; request: ExtensionUiRequestEventPayload }
  >;
  uiState: {
    statuses: Map<string, string | undefined>;
    widgets: Map<
      string,
      { lines: string[] | undefined; placement: "aboveEditor" | "belowEditor" | undefined }
    >;
    workingMessage: string | undefined;
    hiddenThinkingLabel: string | undefined;
    title: string | undefined;
    toolsExpanded: boolean | undefined;
    editorText: string | undefined;
  };
}

type AcceptedSessionCommandPayloadByKind = {
  prompt: PromptCommandRequest;
  steer: SteerCommandRequest;
  "follow-up": FollowUpCommandRequest;
  interrupt: InterruptCommandRequest;
  "active-tools": ActiveToolsUpdateRequest;
  model: ModelUpdateRequest;
  "session-name": SessionNameUpdateRequest;
  settings: SettingsUpdateRequest;
};

type AcceptedSessionCommandBase = {
  commandId: string;
  sessionId: string;
  clientId: string;
  requestId: string | null;
  acceptedAt: number;
  sequence: number;
};

export type AcceptedSessionCommandPayload = AcceptedSessionCommandPayloadByKind[CommandKind];

export type AcceptedSessionCommand = AcceptedSessionCommandBase & {
  kind: CommandKind;
  payload: AcceptedSessionCommandPayload;
};

export interface AcceptCommandHooks {
  beforeAccepted?: (accepted: AcceptedSessionCommand) => Promise<void> | void;
  onAccepted?: (accepted: AcceptedSessionCommand) => Promise<void> | void;
}

export interface SessionRegistryOptions {
  streams: InMemoryDurableStreamStore;
  runtimeFactory: RemoteRuntimeFactory;
  catalog?: SessionCatalog;
  sessionSnapshotEntriesLimit?: number;
  presenceTtlMs?: number;
  runtimeIdleTtlMs?: number;
  now?: () => number;
  watcherDebounceMs?: number;
}

export function createEmptyModelSettings(): SessionRecord["modelSettings"] {
  return {
    defaultProvider: null,
    defaultModel: null,
    defaultThinkingLevel: null,
    enabledModels: null,
  };
}

export function createEmptyResourceBundle(): SessionRecord["resources"] {
  return {
    skills: [],
    prompts: [],
    themes: [],
    modes: undefined,
    systemPrompt: null,
    appendSystemPrompt: [],
  };
}

export function createEmptySettingsSnapshot(): SessionRecord["settings"] {
  return { ...defaultSettings };
}

export function createInitialQueue(): SessionRecord["queue"] {
  return {
    depth: 0,
    nextSequence: 1,
  };
}

export function createIdleTaskState(): { status: "idle" } {
  return { status: "idle" };
}

export function createInitialInterruptedRuntimeDomains(): SessionRecord["interruptedRuntimeDomains"] {
  return {
    queue: false,
    retry: false,
    compaction: false,
    bash: false,
    streaming: false,
  };
}

export function createEmptySessionStats(sessionId: string): SessionStats {
  return {
    sessionFile: undefined,
    sessionId,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    cost: 0,
    contextUsage: undefined,
  };
}

export type SessionCreationInput = {
  input: CreateSessionRequest;
  client: AuthSession;
  connectionId?: string;
};

export const ALLOWED_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export type { ThinkingLevel };
