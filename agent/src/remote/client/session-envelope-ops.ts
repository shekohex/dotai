import type {
  ExtensionUiRequestEventPayload,
  ExtensionUiResolvedEventPayload,
  StreamEventEnvelope,
} from "../schemas.js";
import type { ForwardableRemoteExtensionEvent } from "./session/local-extension-runner.js";

export async function routeRemoteSessionEnvelope(input: {
  envelope: StreamEventEnvelope;
  onAgentSessionPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
  ) => void;
  onExtensionEventPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "extension_event" }>["payload"],
  ) => void;
  onExtensionCustomEventPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "extension_custom_event" }>["payload"],
  ) => void;
  onSessionStatePatchPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "session_state_patch" }>["payload"],
  ) => void;
  onExtensionErrorPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "extension_error" }>["payload"],
  ) => void;
  onExtensionUiRequestPayload: (payload: ExtensionUiRequestEventPayload) => Promise<void>;
  onExtensionUiResolvedPayload: (payload: ExtensionUiResolvedEventPayload) => void;
  onBashStartPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "bash_start" }>["payload"],
  ) => void;
  onBashChunkPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "bash_chunk" }>["payload"],
  ) => void;
  onBashEndPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "bash_end" }>["payload"],
  ) => void;
  onBashFlushPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "bash_flush" }>["payload"],
  ) => void;
}): Promise<void> {
  if (input.envelope.kind === "agent_session_event") {
    input.onAgentSessionPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "extension_event") {
    input.onExtensionEventPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "extension_custom_event") {
    input.onExtensionCustomEventPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "session_state_patch") {
    input.onSessionStatePatchPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "extension_error") {
    input.onExtensionErrorPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "extension_ui_request") {
    await input.onExtensionUiRequestPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "extension_ui_resolved") {
    input.onExtensionUiResolvedPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "bash_start") {
    input.onBashStartPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "bash_chunk") {
    input.onBashChunkPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "bash_end") {
    input.onBashEndPayload(input.envelope.payload);
    return;
  }

  if (input.envelope.kind === "bash_flush") {
    input.onBashFlushPayload(input.envelope.payload);
  }
}

export function applyAgentSessionEnvelopePayload(input: {
  payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"];
  applyAgentSessionEvent: (
    event: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
  ) => void;
}): void {
  input.applyAgentSessionEvent(input.payload);
}

export function applyExtensionEnvelopePayload(input: {
  payload: unknown;
  isForwardableRemoteExtensionEvent: (value: unknown) => value is ForwardableRemoteExtensionEvent;
  applyExtensionEvent: (event: ForwardableRemoteExtensionEvent) => void;
}): void {
  if (!input.isForwardableRemoteExtensionEvent(input.payload)) {
    return;
  }
  input.applyExtensionEvent(input.payload);
}

export function applyBashStartEnvelopePayload(input: {
  payload: Extract<StreamEventEnvelope, { kind: "bash_start" }>["payload"];
  handleBashStart: (
    payload: Extract<StreamEventEnvelope, { kind: "bash_start" }>["payload"],
  ) => void;
}): void {
  input.handleBashStart(input.payload);
}

export function applyBashChunkEnvelopePayload(input: {
  payload: Extract<StreamEventEnvelope, { kind: "bash_chunk" }>["payload"];
  handleBashChunk: (
    payload: Extract<StreamEventEnvelope, { kind: "bash_chunk" }>["payload"],
  ) => void;
}): void {
  input.handleBashChunk(input.payload);
}

export function applyBashEndEnvelopePayload(input: {
  payload: Extract<StreamEventEnvelope, { kind: "bash_end" }>["payload"];
  handleBashEnd: (payload: Extract<StreamEventEnvelope, { kind: "bash_end" }>["payload"]) => void;
}): void {
  input.handleBashEnd(input.payload);
}

export function applyBashFlushEnvelopePayload(input: {
  payload: Extract<StreamEventEnvelope, { kind: "bash_flush" }>["payload"];
  handleBashFlush: (
    payload: Extract<StreamEventEnvelope, { kind: "bash_flush" }>["payload"],
  ) => void;
}): void {
  input.handleBashFlush(input.payload);
}
