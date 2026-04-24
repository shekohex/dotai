import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
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
  CommandKind,
  CreateSessionRequest,
  Presence,
  RemoteExtensionMetadata,
  RemoteResourceBundle,
  RemoteSettingsSnapshot,
  SessionSnapshot,
  SessionStatus,
  UiResponseRequest,
} from "../schemas.js";
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
  sessionName: string;
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
  transcript: unknown[];
  queue: {
    depth: number;
    nextSequence: number;
  };
  retry: {
    status: string;
  };
  compaction: {
    status: string;
  };
  activeRun: SessionSnapshot["activeRun"];
  streamingState: string;
  pendingToolCalls: unknown[];
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
  pendingUiRequests: Map<string, { resolve: (value: UiResponseRequest) => void }>;
}

export interface AcceptedSessionCommand {
  commandId: string;
  sessionId: string;
  clientId: string;
  requestId: string | null;
  kind: CommandKind;
  payload: unknown;
  acceptedAt: number;
  sequence: number;
}

export interface AcceptCommandHooks {
  beforeAccepted?: (accepted: AcceptedSessionCommand) => Promise<void> | void;
  onAccepted?: (accepted: AcceptedSessionCommand) => Promise<void> | void;
}

export interface SessionRegistryOptions {
  streams: InMemoryDurableStreamStore;
  runtimeFactory: RemoteRuntimeFactory;
  catalog?: SessionCatalog;
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
