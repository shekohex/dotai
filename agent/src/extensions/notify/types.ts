import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const NOTIFY_AUTH_PROVIDER = "ntfy";
export const NOTIFY_DEFAULT_BASE_URL = "https://ntfy.0iq.xyz";
export const NOTIFY_PUBLISH_EVENT = "notify:publish";
export const NOTIFY_PUBLISHED_EVENT = "notify:published";
export const NOTIFY_FAILED_EVENT = "notify:failed";
export const NOTIFY_RECEIVED_EVENT = "notify:received";
export const NOTIFY_ACTION_INVOKED_EVENT = "notify:action_invoked";
export const NOTIFY_ACTION_RESPONSE_EVENT = "notify:action_response";

export const NotifyPrioritySchema = Type.Union([
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
  Type.Literal(4),
  Type.Literal(5),
]);

export const NotifyCallbackConfigSchema = Type.Object(
  {
    channel: Type.String(),
    payload: Type.Optional(Type.Unknown()),
    awaitResponse: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    replyChannel: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const NotifyActionBaseSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    label: Type.String(),
    clear: Type.Optional(Type.Boolean()),
    callback: Type.Optional(NotifyCallbackConfigSchema),
  },
  { additionalProperties: false },
);

export const NotifyViewActionSchema = Type.Intersect([
  NotifyActionBaseSchema,
  Type.Object(
    {
      action: Type.Literal("view"),
      url: Type.String({ format: "uri" }),
    },
    { additionalProperties: false },
  ),
]);

export const NotifyHttpActionSchema = Type.Intersect([
  NotifyActionBaseSchema,
  Type.Object(
    {
      action: Type.Literal("http"),
      url: Type.String({ format: "uri" }),
      method: Type.Optional(
        Type.Union([
          Type.Literal("GET"),
          Type.Literal("POST"),
          Type.Literal("PUT"),
          Type.Literal("PATCH"),
          Type.Literal("DELETE"),
        ]),
      ),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      body: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

export const NotifyCallbackActionSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    label: Type.String(),
    clear: Type.Optional(Type.Boolean()),
    action: Type.Literal("callback"),
    key: Type.String(),
    payload: Type.Optional(Type.Unknown()),
    awaitResponse: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    replyChannel: Type.Optional(Type.String()),
    method: Type.Optional(
      Type.Union([
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("PATCH"),
        Type.Literal("DELETE"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const NotifyBroadcastActionSchema = Type.Intersect([
  NotifyActionBaseSchema,
  Type.Object(
    {
      action: Type.Literal("broadcast"),
      intent: Type.Optional(Type.String()),
      extras: Type.Optional(Type.Record(Type.String(), Type.String())),
    },
    { additionalProperties: false },
  ),
]);

export const NotifyCopyActionSchema = Type.Intersect([
  NotifyActionBaseSchema,
  Type.Object(
    {
      action: Type.Literal("copy"),
      value: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

export const NotifyActionSchema = Type.Union([
  NotifyViewActionSchema,
  NotifyHttpActionSchema,
  NotifyCallbackActionSchema,
  NotifyBroadcastActionSchema,
  NotifyCopyActionSchema,
]);

export const NotifyMetaSchema = Type.Object(
  {
    sourceExtension: Type.String(),
    eventName: Type.Optional(Type.String()),
    correlationId: Type.Optional(Type.String()),
    dedupeKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const NotifyPublishPayloadSchema = Type.Object(
  {
    topic: Type.Union([Type.String(), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })]),
    message: Type.String(),
    title: Type.Optional(Type.String()),
    priority: Type.Optional(NotifyPrioritySchema),
    tags: Type.Optional(Type.Array(Type.String())),
    markdown: Type.Optional(Type.Boolean()),
    click: Type.Optional(Type.String({ format: "uri" })),
    attach: Type.Optional(Type.String({ format: "uri" })),
    filename: Type.Optional(Type.String()),
    icon: Type.Optional(Type.String({ format: "uri" })),
    delay: Type.Optional(Type.Union([Type.String(), Type.Integer({ minimum: 0 })])),
    email: Type.Optional(Type.Union([Type.String(), Type.Literal("yes")])),
    call: Type.Optional(Type.Union([Type.String(), Type.Literal("yes")])),
    cache: Type.Optional(Type.Boolean()),
    firebase: Type.Optional(Type.Boolean()),
    unifiedPush: Type.Optional(Type.Boolean()),
    sequenceId: Type.Optional(Type.String()),
    actions: Type.Optional(Type.Array(NotifyActionSchema, { maxItems: 3 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    meta: Type.Optional(NotifyMetaSchema),
  },
  { additionalProperties: false },
);

export const NotifySubscriptionModeSchema = Type.Union([
  Type.Literal("json"),
  Type.Literal("sse"),
  Type.Literal("ws"),
]);

export const NotifySettingsSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    tool: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    baseUrl: Type.Optional(Type.String({ format: "uri" })),
    defaultTopic: Type.Optional(Type.String()),
    allowAnonymous: Type.Optional(Type.Boolean()),
    publishTimeoutMs: Type.Optional(Type.Integer({ minimum: 100 })),
    debugEvents: Type.Optional(Type.Boolean()),
    defaultTags: Type.Optional(Type.Array(Type.String())),
    defaultPriority: Type.Optional(NotifyPrioritySchema),
    retryMaxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
    retryBaseDelayMs: Type.Optional(Type.Integer({ minimum: 1 })),
    subscribe: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          topics: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          mode: Type.Optional(NotifySubscriptionModeSchema),
          since: Type.Optional(
            Type.Union([Type.String(), Type.Integer({ minimum: 0 }), Type.Literal("all")]),
          ),
          poll: Type.Optional(Type.Boolean()),
          pollIntervalMs: Type.Optional(Type.Integer({ minimum: 1000 })),
        },
        { additionalProperties: false },
      ),
    ),
    callbackServer: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          host: Type.Optional(Type.String()),
          port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
          publicBaseUrl: Type.Optional(Type.String({ format: "uri" })),
          signingSecret: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const NotifyPublishedEventSchema = Type.Object(
  {
    topic: Type.String(),
    request: NotifyPublishPayloadSchema,
    normalizedRequest: NotifyPublishPayloadSchema,
    response: Type.Object(
      {
        status: Type.Integer(),
        body: Type.String(),
      },
      { additionalProperties: false },
    ),
    timestamp: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const NotifyFailedEventSchema = Type.Object(
  {
    topic: Type.Optional(Type.String()),
    request: NotifyPublishPayloadSchema,
    normalizedRequest: NotifyPublishPayloadSchema,
    error: Type.String(),
    classification: Type.Union([
      Type.Literal("network"),
      Type.Literal("http"),
      Type.Literal("config"),
      Type.Literal("auth"),
      Type.Literal("validation"),
      Type.Literal("unknown"),
    ]),
    retryable: Type.Boolean(),
    status: Type.Optional(Type.Integer()),
    attempts: Type.Integer({ minimum: 1 }),
    timestamp: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const NotifyIncomingMessageSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    time: Type.Optional(Type.Integer()),
    event: Type.String(),
    topic: Type.String(),
    title: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    priority: Type.Optional(Type.Integer()),
    click: Type.Optional(Type.String()),
    attachment: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(Type.String()),
          url: Type.String(),
          type: Type.Optional(Type.String()),
          size: Type.Optional(Type.Integer()),
          expires: Type.Optional(Type.Integer()),
        },
        { additionalProperties: false },
      ),
    ),
    actions: Type.Optional(Type.Array(Type.Unknown())),
    raw: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

export const NotifyReceivedEventSchema = Type.Object(
  {
    receivedAt: Type.Integer({ minimum: 0 }),
    topic: Type.String(),
    message: NotifyIncomingMessageSchema,
  },
  { additionalProperties: false },
);

export const NotifyActionInvokedEventSchema = Type.Object(
  {
    correlationId: Type.String(),
    actionId: Type.String(),
    sourceExtension: Type.String(),
    callbackChannel: Type.String(),
    callbackPayload: Type.Optional(Type.Unknown()),
    replyChannel: Type.Optional(Type.String()),
    request: Type.Object(
      {
        method: Type.String(),
        path: Type.String(),
        query: Type.Record(Type.String(), Type.String()),
        headers: Type.Record(Type.String(), Type.String()),
        body: Type.String(),
        timestamp: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const NotifyActionResponseEventSchema = Type.Object(
  {
    correlationId: Type.String(),
    statusCode: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
    body: Type.Optional(Type.String()),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);

export type NotifyAction = Static<typeof NotifyActionSchema>;
export type NotifyPublishPayload = Static<typeof NotifyPublishPayloadSchema>;
export type NotifySettings = Static<typeof NotifySettingsSchema>;
export type NotifyPublishedEvent = Static<typeof NotifyPublishedEventSchema>;
export type NotifyFailedEvent = Static<typeof NotifyFailedEventSchema>;
export type NotifyIncomingMessage = Static<typeof NotifyIncomingMessageSchema>;
export type NotifyReceivedEvent = Static<typeof NotifyReceivedEventSchema>;
export type NotifyActionInvokedEvent = Static<typeof NotifyActionInvokedEventSchema>;
export type NotifyActionResponseEvent = Static<typeof NotifyActionResponseEventSchema>;
export type NotifyCallbackConfig = Static<typeof NotifyCallbackConfigSchema>;

export interface ResolvedNotifySettings {
  enabled: boolean;
  tool: {
    enabled: boolean;
  };
  baseUrl: string;
  defaultTopic?: string;
  allowAnonymous: boolean;
  publishTimeoutMs: number;
  debugEvents: boolean;
  defaultTags: string[];
  defaultPriority?: Static<typeof NotifyPrioritySchema>;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  subscribe?: {
    enabled: boolean;
    topics: string[];
    mode: Static<typeof NotifySubscriptionModeSchema>;
    since?: string | number;
    poll: boolean;
    pollIntervalMs: number;
  };
  callbackServer?: {
    enabled: boolean;
    host: string;
    port?: number;
    publicBaseUrl?: string;
    signingSecret: string;
  };
}

export function parseSettings(value: unknown): NotifySettings | null {
  if (!Value.Check(NotifySettingsSchema, value)) {
    return null;
  }
  return Value.Parse(NotifySettingsSchema, value);
}

export function parsePublishPayload(value: unknown): NotifyPublishPayload | null {
  if (!Value.Check(NotifyPublishPayloadSchema, value)) {
    return null;
  }
  return Value.Parse(NotifyPublishPayloadSchema, value);
}

export function parseIncomingMessage(value: unknown): NotifyIncomingMessage | null {
  if (!Value.Check(NotifyIncomingMessageSchema, value)) {
    return null;
  }
  return Value.Parse(NotifyIncomingMessageSchema, value);
}

export function parseActionResponse(value: unknown): NotifyActionResponseEvent | null {
  if (!Value.Check(NotifyActionResponseEventSchema, value)) {
    return null;
  }
  return Value.Parse(NotifyActionResponseEventSchema, value);
}

export function createSigningSecret(): string {
  return randomBytes(24).toString("hex");
}
