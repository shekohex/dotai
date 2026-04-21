import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  ExtensionUiRequestEventPayload,
  ExtensionUiResolvedEventPayload,
  StreamEventEnvelope,
} from "../schemas.js";
import {
  ExtensionUiRequestEventPayloadSchema,
  ExtensionUiResolvedEventPayloadSchema,
} from "../schemas.js";
import { assertType } from "../typebox.js";

export async function routeRemoteSessionEnvelope(input: {
  envelope: StreamEventEnvelope;
  onAgentSessionPayload: (payload: unknown) => void;
  onSessionStatePatchPayload: (payload: unknown) => void;
  onExtensionErrorPayload: (payload: unknown) => void;
  onExtensionUiRequestPayload: (payload: unknown) => Promise<void>;
  onExtensionUiResolvedPayload: (payload: unknown) => void;
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

export function validateExtensionUiRequestPayload(
  payload: unknown,
): { ok: true; value: ExtensionUiRequestEventPayload } | { ok: false; message: string } {
  try {
    assertType(ExtensionUiRequestEventPayloadSchema, payload);
    return { ok: true, value: payload };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid UI request payload",
    };
  }
}

export function validateExtensionUiResolvedPayload(
  payload: unknown,
): { ok: true; value: ExtensionUiResolvedEventPayload } | { ok: false; message: string } {
  try {
    assertType(ExtensionUiResolvedEventPayloadSchema, payload);
    return { ok: true, value: payload };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid UI resolved payload",
    };
  }
}
