import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { LiveVoiceSchema } from "../voices.js";

export const LIVE_PAIRING_PROTOCOL_VERSION = 1;

const JsonRpcIdSchema = Type.Union([Type.String(), Type.Number()]);

export const JsonRpcRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: JsonRpcIdSchema,
    method: Type.String(),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const JsonRpcNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: Type.String(),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const JsonRpcResponseSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: JsonRpcIdSchema,
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Number(),
          message: Type.String(),
          data: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const PairRequestParamsSchema = Type.Object(
  {
    protocolVersion: Type.Literal(LIVE_PAIRING_PROTOCOL_VERSION),
    secret: Type.String({ minLength: 32 }),
    client: Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        platform: Type.String({ minLength: 1 }),
        appVersion: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    capabilities: Type.Object(
      {
        webrtc: Type.Boolean(),
        inputLevel: Type.Boolean(),
        outputLevel: Type.Boolean(),
        deviceSelection: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    preferences: Type.Optional(
      Type.Object(
        {
          voice: Type.Optional(LiveVoiceSchema),
          instructions: Type.Optional(Type.String({ maxLength: 8_000 })),
          diagnosticsEnabled: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const LivePairingEndpointSchema = Type.Union([
  Type.Object({ type: Type.Literal("local"), url: Type.String() }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal("coder"),
      url: Type.String(),
      requiresCoderToken: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("direct"), url: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("ssh"),
      remoteHost: Type.String(),
      remotePort: Type.Number(),
      targetHint: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

const PairingPayloadSchema = Type.Object(
  {
    protocolVersion: Type.Literal(LIVE_PAIRING_PROTOCOL_VERSION),
    sessionId: Type.String(),
    serverNonce: Type.String(),
    expiresAt: Type.Number(),
    endpoints: Type.Array(LivePairingEndpointSchema),
  },
  { additionalProperties: false },
);

export type JsonRpcId = Static<typeof JsonRpcIdSchema>;
export type JsonRpcRequest = Static<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = Static<typeof JsonRpcNotificationSchema>;
export type JsonRpcResponse = Static<typeof JsonRpcResponseSchema>;
export type PairRequestParams = Static<typeof PairRequestParamsSchema>;

export type LivePairingEndpoint =
  | { type: "local"; url: string }
  | { type: "coder"; url: string; requiresCoderToken: true }
  | { type: "direct"; url: string }
  | { type: "ssh"; remoteHost: string; remotePort: number; targetHint?: string };

export interface PairingPayload {
  protocolVersion: typeof LIVE_PAIRING_PROTOCOL_VERSION;
  sessionId: string;
  serverNonce: string;
  expiresAt: number;
  endpoints: LivePairingEndpoint[];
}

export interface PairingDescriptor extends PairingPayload {
  uri: string;
}

export function parseJsonRpcMessage(
  payload: string,
):
  | { kind: "request"; value: JsonRpcRequest }
  | { kind: "notification"; value: JsonRpcNotification }
  | { kind: "response"; value: JsonRpcResponse }
  | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
  if (Value.Check(JsonRpcRequestSchema, parsed)) {
    return { kind: "request", value: Value.Parse(JsonRpcRequestSchema, parsed) };
  }
  if (Value.Check(JsonRpcNotificationSchema, parsed)) {
    return { kind: "notification", value: Value.Parse(JsonRpcNotificationSchema, parsed) };
  }
  if (Value.Check(JsonRpcResponseSchema, parsed)) {
    return { kind: "response", value: Value.Parse(JsonRpcResponseSchema, parsed) };
  }
  return undefined;
}

export function parsePairRequestParams(value: unknown): PairRequestParams | undefined {
  return Value.Check(PairRequestParamsSchema, value)
    ? Value.Parse(PairRequestParamsSchema, value)
    : undefined;
}

export function encodePairingUri(payload: PairingPayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const fragment = new URLSearchParams({ payload: encodedPayload, secret });
  return `pi-live://pair#${fragment.toString()}`;
}

export function decodePairingUri(uri: string): { payload: PairingPayload; secret: string } {
  const url = new URL(uri);
  if (url.protocol !== "pi-live:" || url.hostname !== "pair") {
    throw new Error("Invalid Pi Live pairing URL");
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const encodedPayload = params.get("payload");
  const secret = params.get("secret");
  if (
    encodedPayload === null ||
    encodedPayload.length === 0 ||
    secret === null ||
    secret.length === 0
  ) {
    throw new Error("Pairing URL is missing payload or secret");
  }
  const parsed: unknown = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  if (!Value.Check(PairingPayloadSchema, parsed)) {
    throw new Error("Pairing URL payload is invalid");
  }
  const payload: PairingPayload = Value.Parse(PairingPayloadSchema, parsed);
  return { payload, secret };
}
