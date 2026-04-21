import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSessionRuntime, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { defaultSettings } from "../../default-settings.js";
import { theme as defaultTheme } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { AuthSession } from "../auth.js";
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

export type RenderableComponent = {
  render: (width: number) => string[];
  invalidate: () => void;
  dispose?: () => void;
};

export type RemoteUiRenderState = {
  theme: typeof defaultTheme;
  footerStatuses: Map<string, string>;
  footerData: {
    getGitBranch: () => null;
    getExtensionStatuses: () => Map<string, string>;
    getAvailableProviderCount: () => number;
    onBranchChange: () => () => void;
  };
  headerComponent: RenderableComponent | undefined;
  footerComponent: RenderableComponent | undefined;
  renderHeader: () => void;
  renderFooter: () => void;
  tui: {
    requestRender: () => void;
  };
};

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
  | "setHiddenThinkingLabel"
  | "setWidget"
  | "setTitle"
  | "getToolsExpanded"
  | "setToolsExpanded"
>;

export interface SessionRecord {
  sessionId: string;
  sessionName: string;
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
  draft: {
    text: string;
    attachments: string[];
    revision: number;
    updatedAt: number;
    updatedByClientId: string | null;
  };
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
  presenceTtlMs?: number;
  now?: () => number;
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

export function createInitialDraft(createdAt: number): SessionRecord["draft"] {
  return {
    text: "",
    attachments: [],
    revision: 0,
    updatedAt: createdAt,
    updatedByClientId: null,
  };
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
