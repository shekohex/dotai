import { Type, type Static } from "typebox";

export const AGENT_ALERT_EVENT = "agent-alerts:raised";
export const AGENT_ALERT_RETRY_EVENT = "agent-alerts:retry_requested";

export const AgentAlertKindSchema = Type.Union([Type.Literal("provider_retryable_response")]);

export const AgentAlertEventSchema = Type.Object(
  {
    alertId: Type.String(),
    kind: AgentAlertKindSchema,
    message: Type.String(),
    statusCode: Type.Optional(Type.Integer()),
    sessionId: Type.Optional(Type.String()),
    timestamp: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AgentAlertRetryEventSchema = Type.Object(
  {
    alertId: Type.String(),
    kind: AgentAlertKindSchema,
    sessionId: Type.Optional(Type.String()),
    timestamp: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type AgentAlertEvent = Static<typeof AgentAlertEventSchema>;
export type AgentAlertRetryEvent = Static<typeof AgentAlertRetryEventSchema>;
