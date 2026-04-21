import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSessionEvent, ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type { RemoteApiClient } from "../../remote-api-client.js";
import type {
  ExtensionUiRequestEventPayload,
  RemoteExtensionMetadata,
  StreamEventEnvelope,
} from "../../schemas.js";
import type { RemoteModelSettingsState } from "../contracts.js";
import {
  applyAgentSessionEnvelopePayload,
  routeRemoteSessionEnvelope,
  validateExtensionUiResolvedPayload,
  validateExtensionUiRequestPayload,
} from "../session-envelope-ops.js";
import { applyRemoteSessionStatePatch } from "../session-patches.js";
import { pollRemoteSessionEvents } from "../session-polling.js";
import { handleRemoteUiRequest } from "../session-ui.js";

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
  readErrorMessage: (payload: unknown) => string | undefined;
  applyAgentSessionEvent: (event: AgentSessionEvent) => void;
  remoteModelSettings: RemoteModelSettingsState;
  setRemoteAvailableModels: (models: Model<Api>[]) => void;
  setResolvedModel: (modelRef: string) => void;
  setThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
  applyAuthoritativeCwd: (cwd: string) => void;
  setRemoteExtensions: (extensions: RemoteExtensionMetadata[]) => void;
  setSessionName: (sessionName: string) => void;
  setActiveTools: (activeTools: string[]) => void;
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
  readErrorMessage: PollRemoteSessionRuntimeInput["readErrorMessage"];
  applyAgentSessionEvent: PollRemoteSessionRuntimeInput["applyAgentSessionEvent"];
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
    readErrorMessage: input.readErrorMessage,
    applyAgentSessionEvent: input.applyAgentSessionEvent,
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
    onSessionStatePatchPayload: (payload) => {
      handleSessionStatePatchPayload(input, payload);
    },
    onExtensionErrorPayload: (payload) => {
      const errorMessage = input.readErrorMessage(payload);
      input.handleRemoteError(errorMessage ?? "Remote command execution failed");
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
  payload: unknown,
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
  });
}

async function handleExtensionUiRequestPayload(
  input: PollRemoteSessionRuntimeInput,
  payload: unknown,
): Promise<void> {
  const validatedPayload = validateExtensionUiRequestPayload(payload);
  if (!validatedPayload.ok) {
    input.handleRemoteError(`Invalid extension UI request payload: ${validatedPayload.message}`);
    return;
  }

  const uiContext = input.getUiContext();
  if (!uiContext) {
    input.bufferUiRequest(validatedPayload.value);
    return;
  }

  await handleRemoteUiRequest({
    uiContext,
    request: validatedPayload.value,
    client: input.client,
    sessionId: input.sessionId,
    pendingInteractiveRequests: input.pendingInteractiveRequests,
  });
}

function handleExtensionUiResolvedPayload(
  input: PollRemoteSessionRuntimeInput,
  payload: unknown,
): void {
  const validatedPayload = validateExtensionUiResolvedPayload(payload);
  if (!validatedPayload.ok) {
    input.handleRemoteError(`Invalid extension UI resolved payload: ${validatedPayload.message}`);
    return;
  }

  input.cancelUiRequest(validatedPayload.value.id);
}
