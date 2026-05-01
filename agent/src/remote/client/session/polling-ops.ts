import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ContextUsage, ExtensionUIContext, SessionStats } from "@mariozechner/pi-coding-agent";
import type { RemoteApiClient } from "../../remote-api-client.js";
import type {
  ExtensionUiRequestEventPayload,
  RemoteExtensionMetadata,
  RemoteResourceBundle,
  RemoteSettingsSnapshot,
} from "../../schemas.js";
import type { RemoteModelSettingsState } from "../contracts.js";
import { applyRemoteSessionStatePatch } from "../session-patches.js";
import type { ForwardableRemoteExtensionEvent } from "./local-extension-runner.js";

export type PollRemoteSessionRuntimeInput = {
  handleRemoteError: (message: string) => void;
  isForwardableRemoteExtensionEvent: (value: unknown) => value is ForwardableRemoteExtensionEvent;
  remoteModelSettings: RemoteModelSettingsState;
  setRemoteAvailableModels: (models: Model<Api>[]) => void;
  setResolvedModel: (modelRef: string) => void;
  setThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
  applyAuthoritativeCwd: (cwd: string) => void;
  setRemoteExtensions: (extensions: RemoteExtensionMetadata[]) => void;
  setRemoteResources: (resources: RemoteResourceBundle) => void;
  setSessionName: (sessionName: string | undefined) => void;
  setActiveTools: (activeTools: string[]) => void;
  setContextUsage: (contextUsage: ContextUsage | undefined) => void;
  setSessionStats: (sessionStats: SessionStats) => void;
  setUsageCost: (usageCost: number) => void;
  setIsBashRunning: (isBashRunning: boolean) => void;
  setHasPendingBashMessages: (hasPendingBashMessages: boolean) => void;
  setAutoCompactionEnabled: (enabled: boolean) => void;
  setSteeringMode: (mode: "all" | "one-at-a-time") => void;
  setFollowUpMode: (mode: "all" | "one-at-a-time") => void;
  setRemoteSettings: (settings: RemoteSettingsSnapshot) => void;
  getUiContext: () => ExtensionUIContext | undefined;
  bufferUiRequest: (request: ExtensionUiRequestEventPayload) => void;
  pendingInteractiveRequests: Map<string, AbortController>;
  cancelUiRequest: (requestId: string) => void;
  client: RemoteApiClient;
  sessionId: string;
};

type PollingStateHandlers = Pick<
  PollRemoteSessionRuntimeInput,
  | "setRemoteAvailableModels"
  | "setResolvedModel"
  | "setThinkingLevel"
  | "applyAuthoritativeCwd"
  | "setRemoteExtensions"
  | "setRemoteResources"
  | "setSessionName"
  | "setActiveTools"
  | "setContextUsage"
  | "setSessionStats"
  | "setUsageCost"
  | "setIsBashRunning"
  | "setHasPendingBashMessages"
  | "setAutoCompactionEnabled"
  | "setSteeringMode"
  | "setFollowUpMode"
  | "setRemoteSettings"
  | "getUiContext"
  | "bufferUiRequest"
  | "pendingInteractiveRequests"
  | "cancelUiRequest"
>;

export function createRemoteSessionPollingStateHandlers(
  handlers: PollingStateHandlers,
): PollingStateHandlers {
  return handlers;
}

export function handleSessionStatePatchPayload(
  input: Pick<
    PollRemoteSessionRuntimeInput,
    | "remoteModelSettings"
    | "setRemoteAvailableModels"
    | "setResolvedModel"
    | "setThinkingLevel"
    | "applyAuthoritativeCwd"
    | "setRemoteExtensions"
    | "setRemoteResources"
    | "setSessionName"
    | "setActiveTools"
    | "setContextUsage"
    | "setSessionStats"
    | "setUsageCost"
    | "setIsBashRunning"
    | "setHasPendingBashMessages"
    | "setAutoCompactionEnabled"
    | "setSteeringMode"
    | "setFollowUpMode"
    | "setRemoteSettings"
  >,
  payload: Parameters<typeof applyRemoteSessionStatePatch>[0]["payload"],
): void {
  applyRemoteSessionStatePatch({
    payload,
    remoteModelSettings: input.remoteModelSettings,
    setRemoteAvailableModels: input.setRemoteAvailableModels,
    setResolvedModel: input.setResolvedModel,
    setThinkingLevel: input.setThinkingLevel,
    applyAuthoritativeCwd: input.applyAuthoritativeCwd,
    setRemoteExtensions: input.setRemoteExtensions,
    setRemoteResources: input.setRemoteResources,
    setSessionName: input.setSessionName,
    setActiveTools: input.setActiveTools,
    setContextUsage: input.setContextUsage,
    setSessionStats: input.setSessionStats,
    setUsageCost: input.setUsageCost,
    setIsBashRunning: input.setIsBashRunning,
    setHasPendingBashMessages: input.setHasPendingBashMessages,
    setAutoCompactionEnabled: input.setAutoCompactionEnabled,
    setSteeringMode: input.setSteeringMode,
    setFollowUpMode: input.setFollowUpMode,
    setRemoteSettings: input.setRemoteSettings,
  });
}
