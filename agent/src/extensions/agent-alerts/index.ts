import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createNotifyCallbackAction, publishNotify } from "../notify/index.js";
import { NOTIFY_DEFAULT_TOPIC } from "../notify/settings.js";
import {
  AGENT_ALERT_EVENT,
  AGENT_ALERT_RETRY_EVENT,
  AgentAlertKindSchema,
  type AgentAlertEvent,
  type AgentAlertRetryEvent,
} from "./types.js";

interface ProviderResponseEventLike {
  status: number;
}

const RetryActionPayloadSchema = Type.Object(
  {
    alertId: Type.String(),
    kind: AgentAlertKindSchema,
    sessionId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

function parseRetryActionPayload(
  value: unknown,
): { alertId: string; kind: AgentAlertRetryEvent["kind"]; sessionId?: string } | null {
  if (!Value.Check(RetryActionPayloadSchema, value)) {
    return null;
  }
  return Value.Parse(RetryActionPayloadSchema, value);
}

function createAlertId(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}

function emitAgentAlert(pi: ExtensionAPI, alert: AgentAlertEvent): void {
  pi.events.emit(AGENT_ALERT_EVENT, alert);
  publishNotify(
    pi,
    {
      topic: NOTIFY_DEFAULT_TOPIC,
      title: "Agent alert",
      message: alert.message,
      tags: ["agent", "alert"],
      actions: [
        createNotifyCallbackAction({
          key: "agent-alerts:retry",
          label: "Retry",
          payload: {
            alertId: alert.alertId,
            kind: alert.kind,
            sessionId: alert.sessionId,
          },
        }),
      ],
      meta: {
        sourceExtension: "agent-alerts",
        eventName: AGENT_ALERT_EVENT,
        correlationId: alert.alertId,
      },
    },
    {
      onAction: ({ pi: actionPi, action }) => {
        const callbackPayload = parseRetryActionPayload(action.callbackPayload);
        if (callbackPayload === null) {
          return;
        }
        actionPi.events.emit(AGENT_ALERT_RETRY_EVENT, {
          alertId: callbackPayload.alertId,
          kind: callbackPayload.kind,
          sessionId: callbackPayload.sessionId,
          timestamp: Date.now(),
        } satisfies AgentAlertRetryEvent);
      },
    },
  );
}

function handleProviderResponse(
  pi: ExtensionAPI,
  event: ProviderResponseEventLike,
  ctx: ExtensionContext,
): void {
  if (event.status < 429) {
    return;
  }
  emitAgentAlert(pi, {
    alertId: createAlertId("provider"),
    kind: "provider_retryable_response",
    message: `Provider returned retryable status ${event.status}`,
    statusCode: event.status,
    sessionId: ctx.sessionManager.getSessionId(),
    timestamp: Date.now(),
  });
}

export default function agentAlertsExtension(pi: ExtensionAPI): void {
  pi.on("after_provider_response", (event, ctx) => {
    handleProviderResponse(pi, event, ctx);
  });
}
