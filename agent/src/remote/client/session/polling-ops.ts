import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AgentSessionEvent,
  ContextUsage,
  ExtensionUIContext,
  SessionStats,
} from "@mariozechner/pi-coding-agent";
import type { RemoteApiClient } from "../../remote-api-client.js";
import type {
  ExtensionUiResolvedEventPayload,
  ExtensionUiRequestEventPayload,
  RemoteExtensionMetadata,
  RemoteSettingsSnapshot,
  StreamEventEnvelope,
} from "../../schemas.js";
import type { RemoteModelSettingsState } from "../contracts.js";
import {
  applyAgentSessionEnvelopePayload,
  applyExtensionEnvelopePayload,
  routeRemoteSessionEnvelope,
} from "../session-envelope-ops.js";
import { applyRemoteSessionStatePatch } from "../session-patches.js";
import { pollRemoteSessionEvents } from "../session-polling.js";
import { handleRemoteUiRequest } from "../session-ui.js";
import type { ForwardableRemoteExtensionEvent } from "./local-extension-runner.js";

type ReadSessionEvents = (options: {
  offset: string;
  signal: AbortSignal;
  onEvent: (envelope: StreamEventEnvelope) => Promise<void>;
  onControl: (nextOffset: string) => void;
}) => Promise<{
  events: StreamEventEnvelope[];
  nextOffset: string;
  streamClosed: boolean;
}>;

export type PollRemoteSessionRuntimeInput = {
  isClosed: () => boolean;
  getStreamOffset: () => string;
  setStreamOffset: (offset: string) => void;
  setActiveReadAbortController: (controller: AbortController | undefined) => void;
  readSessionEvents: ReadSessionEvents;
  handleRemoteError: (message: string) => void;
  handleRemoteWarning: (message: string) => void;
  reauthenticate: () => Promise<void>;
  isAgentSessionEventLike: (value: unknown) => value is AgentSessionEvent;
  applyAgentSessionEvent: (event: AgentSessionEvent) => void;
  isForwardableRemoteExtensionEvent: (value: unknown) => value is ForwardableRemoteExtensionEvent;
  applyExtensionEvent: (event: ForwardableRemoteExtensionEvent) => void;
  remoteModelSettings: RemoteModelSettingsState;
  setRemoteAvailableModels: (models: Model<Api>[]) => void;
  setResolvedModel: (modelRef: string) => void;
  setThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
  applyAuthoritativeCwd: (cwd: string) => void;
  setRemoteExtensions: (extensions: RemoteExtensionMetadata[]) => void;
  setSessionName: (sessionName: string) => void;
  setActiveTools: (activeTools: string[]) => void;
  setContextUsage: (contextUsage: ContextUsage | undefined) => void;
  setSessionStats: (sessionStats: SessionStats) => void;
  setUsageCost: (usageCost: number) => void;
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
  handleEnvelope?: (envelope: StreamEventEnvelope) => Promise<void>;
};

type PollingStateHandlers = Pick<
  PollRemoteSessionRuntimeInput,
  | "setRemoteAvailableModels"
  | "setResolvedModel"
  | "setThinkingLevel"
  | "applyAuthoritativeCwd"
  | "setRemoteExtensions"
  | "setSessionName"
  | "setActiveTools"
  | "setContextUsage"
  | "setSessionStats"
  | "setUsageCost"
  | "setAutoCompactionEnabled"
  | "setSteeringMode"
  | "setFollowUpMode"
  | "setRemoteSettings"
  | "getUiContext"
  | "bufferUiRequest"
  | "pendingInteractiveRequests"
  | "cancelUiRequest"
>;

export function createRemoteSessionPollingInput(input: {
  isClosed: PollRemoteSessionRuntimeInput["isClosed"];
  getStreamOffset: PollRemoteSessionRuntimeInput["getStreamOffset"];
  setStreamOffset: PollRemoteSessionRuntimeInput["setStreamOffset"];
  setActiveReadAbortController: PollRemoteSessionRuntimeInput["setActiveReadAbortController"];
  readSessionEvents: PollRemoteSessionRuntimeInput["readSessionEvents"];
  handleRemoteError: PollRemoteSessionRuntimeInput["handleRemoteError"];
  handleRemoteWarning: PollRemoteSessionRuntimeInput["handleRemoteWarning"];
  reauthenticate: PollRemoteSessionRuntimeInput["reauthenticate"];
  isAgentSessionEventLike: PollRemoteSessionRuntimeInput["isAgentSessionEventLike"];
  applyAgentSessionEvent: PollRemoteSessionRuntimeInput["applyAgentSessionEvent"];
  isForwardableRemoteExtensionEvent: PollRemoteSessionRuntimeInput["isForwardableRemoteExtensionEvent"];
  applyExtensionEvent: PollRemoteSessionRuntimeInput["applyExtensionEvent"];
  handleEnvelope: PollRemoteSessionRuntimeInput["handleEnvelope"];
  remoteModelSettings: PollRemoteSessionRuntimeInput["remoteModelSettings"];
  stateHandlers: PollingStateHandlers;
  client: PollRemoteSessionRuntimeInput["client"];
  sessionId: PollRemoteSessionRuntimeInput["sessionId"];
}): PollRemoteSessionRuntimeInput {
  return {
    isClosed: input.isClosed,
    getStreamOffset: input.getStreamOffset,
    setStreamOffset: input.setStreamOffset,
    setActiveReadAbortController: input.setActiveReadAbortController,
    readSessionEvents: input.readSessionEvents,
    handleRemoteError: input.handleRemoteError,
    handleRemoteWarning: input.handleRemoteWarning,
    reauthenticate: input.reauthenticate,
    isAgentSessionEventLike: input.isAgentSessionEventLike,
    applyAgentSessionEvent: input.applyAgentSessionEvent,
    isForwardableRemoteExtensionEvent: input.isForwardableRemoteExtensionEvent,
    applyExtensionEvent: input.applyExtensionEvent,
    handleEnvelope: input.handleEnvelope,
    remoteModelSettings: input.remoteModelSettings,
    ...input.stateHandlers,
    client: input.client,
    sessionId: input.sessionId,
  };
}

export function createRemoteSessionPollingStateHandlers(
  handlers: PollingStateHandlers,
): PollingStateHandlers {
  return handlers;
}

export async function pollRemoteSessionRuntime(
  input: PollRemoteSessionRuntimeInput,
): Promise<void> {
  const handleEnvelopeCallback =
    input.handleEnvelope ??
    (async (envelope: StreamEventEnvelope) => {
      await handleRemoteSessionEnvelope(input, envelope);
    });

  await pollRemoteSessionEvents({
    isClosed: input.isClosed,
    getStreamOffset: input.getStreamOffset,
    setStreamOffset: input.setStreamOffset,
    setActiveReadAbortController: input.setActiveReadAbortController,
    readSessionEvents: input.readSessionEvents,
    handleEnvelope: handleEnvelopeCallback,
    handleRemoteError: input.handleRemoteError,
    handleRemoteWarning: input.handleRemoteWarning,
    reauthenticate: input.reauthenticate,
  });
}

export async function handleRemoteSessionEnvelope(
  input: PollRemoteSessionRuntimeInput,
  envelope: StreamEventEnvelope,
): Promise<void> {
  await routeRemoteSessionEnvelope({
    envelope,
    onAgentSessionPayload: (payload) => {
      applyAgentSessionEnvelopePayload({
        payload,
        isAgentSessionEventLike: input.isAgentSessionEventLike,
        applyAgentSessionEvent: input.applyAgentSessionEvent,
      });
    },
    onExtensionEventPayload: (payload) => {
      applyExtensionEnvelopePayload({
        payload,
        isForwardableRemoteExtensionEvent: input.isForwardableRemoteExtensionEvent,
        applyExtensionEvent: input.applyExtensionEvent,
      });
    },
    onSessionStatePatchPayload: (payload) => {
      handleSessionStatePatchPayload(input, payload);
    },
    onExtensionErrorPayload: (payload) => {
      input.handleRemoteError(payload.error);
    },
    onExtensionUiRequestPayload: async (payload) => {
      await handleExtensionUiRequestPayload(input, payload);
    },
    onExtensionUiResolvedPayload: (payload) => {
      handleExtensionUiResolvedPayload(input, payload);
    },
  });
}

function handleSessionStatePatchPayload(
  input: PollRemoteSessionRuntimeInput,
  payload: Extract<StreamEventEnvelope, { kind: "session_state_patch" }>["payload"],
): void {
  applyRemoteSessionStatePatch({
    payload,
    remoteModelSettings: input.remoteModelSettings,
    setRemoteAvailableModels: input.setRemoteAvailableModels,
    setResolvedModel: input.setResolvedModel,
    setThinkingLevel: input.setThinkingLevel,
    applyAuthoritativeCwd: input.applyAuthoritativeCwd,
    setRemoteExtensions: input.setRemoteExtensions,
    setSessionName: input.setSessionName,
    setActiveTools: input.setActiveTools,
    setContextUsage: input.setContextUsage,
    setSessionStats: input.setSessionStats,
    setUsageCost: input.setUsageCost,
    setAutoCompactionEnabled: input.setAutoCompactionEnabled,
    setSteeringMode: input.setSteeringMode,
    setFollowUpMode: input.setFollowUpMode,
    setRemoteSettings: input.setRemoteSettings,
  });
}

async function handleExtensionUiRequestPayload(
  input: PollRemoteSessionRuntimeInput,
  payload: ExtensionUiRequestEventPayload,
): Promise<void> {
  const uiContext = input.getUiContext();
  if (!uiContext) {
    input.bufferUiRequest(payload);
    return;
  }

  await handleRemoteUiRequest({
    uiContext,
    request: payload,
    client: input.client,
    sessionId: input.sessionId,
    pendingInteractiveRequests: input.pendingInteractiveRequests,
  });
}

function handleExtensionUiResolvedPayload(
  input: PollRemoteSessionRuntimeInput,
  payload: ExtensionUiResolvedEventPayload,
): void {
  input.cancelUiRequest(payload.id);
}
