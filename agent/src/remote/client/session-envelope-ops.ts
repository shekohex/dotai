import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionUiRequestEventPayload,
  ExtensionUiResolvedEventPayload,
  StreamEventEnvelope,
} from "../schemas.js";

export async function routeRemoteSessionEnvelope(input: {
  envelope: StreamEventEnvelope;
  onAgentSessionPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "agent_session_event" }>["payload"],
  ) => void;
  onSessionStatePatchPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "session_state_patch" }>["payload"],
  ) => void;
  onExtensionErrorPayload: (
    payload: Extract<StreamEventEnvelope, { kind: "extension_error" }>["payload"],
  ) => void;
  onExtensionUiRequestPayload: (payload: ExtensionUiRequestEventPayload) => Promise<void>;
  onExtensionUiResolvedPayload: (payload: ExtensionUiResolvedEventPayload) => void;
}): Promise<void> {
  if (input.envelope.kind === "agent_session_event") {
    input.onAgentSessionPayload(input.envelope.payload);
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
  }
}

export function applyAgentSessionEnvelopePayload(input: {
  payload: unknown;
  isAgentSessionEventLike: (value: unknown) => value is AgentSessionEvent;
  applyAgentSessionEvent: (event: AgentSessionEvent) => void;
}): void {
  if (!input.isAgentSessionEventLike(input.payload)) {
    return;
  }
  input.applyAgentSessionEvent(input.payload);
}
