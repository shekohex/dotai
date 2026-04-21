import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type {
  AgentSession,
  AgentSessionRuntime,
  ExtensionFactory,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ClientCapabilities, RemoteExtensionMetadata } from "../schemas.js";

export interface RemoteRuntimeAuthOptions {
  keyId: string;
  privateKey: string;
}

export interface RemoteRuntimeOptions {
  origin: string;
  auth: RemoteRuntimeAuthOptions;
  sessionId?: string;
  sessionName?: string;
  connectionId?: string;
  cwd?: string;
  agentDir?: string;
  clientExtensionMetadata?: RemoteExtensionMetadata[];
  clientExtensionFactories?: ExtensionFactory[];
  clientCapabilities?: ClientCapabilities;
  fetchImpl?: typeof fetch;
}

export interface RemoteSessionContract {
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  modelRegistry: ModelRegistry;
  bindExtensions: AgentSession["bindExtensions"];
  subscribe: AgentSession["subscribe"];
  prompt: AgentSession["prompt"];
  steer: AgentSession["steer"];
  followUp: AgentSession["followUp"];
  sendUserMessage: AgentSession["sendUserMessage"];
  setModel: AgentSession["setModel"];
  cycleModel: AgentSession["cycleModel"];
  setThinkingLevel: AgentSession["setThinkingLevel"];
  cycleThinkingLevel: AgentSession["cycleThinkingLevel"];
  getAvailableThinkingLevels: AgentSession["getAvailableThinkingLevels"];
  setSessionName: AgentSession["setSessionName"];
  getActiveToolNames: AgentSession["getActiveToolNames"];
  getToolDefinition: AgentSession["getToolDefinition"];
  reload: AgentSession["reload"];
}

export interface RemoteModelSettingsState {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  enabledModels?: string[];
}

export interface RemoteRuntimeContract {
  session: RemoteSessionContract;
  diagnostics: AgentSessionRuntime["diagnostics"];
  modelFallbackMessage: AgentSessionRuntime["modelFallbackMessage"];
  services: Pick<
    AgentSessionRuntime["services"],
    "settingsManager" | "modelRegistry" | "resourceLoader"
  >;
  newSession: AgentSessionRuntime["newSession"];
  switchSession: AgentSessionRuntime["switchSession"];
  fork: AgentSessionRuntime["fork"];
  importFromJsonl: AgentSessionRuntime["importFromJsonl"];
  dispose: AgentSessionRuntime["dispose"];
}
