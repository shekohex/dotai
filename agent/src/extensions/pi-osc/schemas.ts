import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { PiOscV1Event } from "./encoder.js";

const BoundedString = (maxLength: number): TSchema => Type.String({ minLength: 1, maxLength });

export const PiOscHelloPayloadSchema = Type.Object(
  {
    protocol: Type.Literal(1),
    extension: Type.Literal("pi-osc"),
    version: Type.Number(),
  },
  { additionalProperties: false },
);

export const PiOscAgentSessionPayloadSchema = Type.Object(
  {
    state: Type.Literal("started"),
    reason: Type.Union([
      Type.Literal("startup"),
      Type.Literal("reload"),
      Type.Literal("new"),
      Type.Literal("resume"),
      Type.Literal("fork"),
    ]),
  },
  { additionalProperties: false },
);

export const PiOscAgentRunPayloadSchema = Type.Object(
  {
    state: Type.Union([Type.Literal("running"), Type.Literal("idle")]),
  },
  { additionalProperties: false },
);

export const PiOscAgentTurnPayloadSchema = Type.Object(
  {
    state: Type.Union([Type.Literal("running"), Type.Literal("complete")]),
    turnIndex: Type.Number(),
  },
  { additionalProperties: false },
);

export const PiOscAgentProgressPayloadSchema = Type.Object(
  {
    state: Type.Union([Type.Literal("active"), Type.Literal("clear")]),
  },
  { additionalProperties: false },
);

export const PiOscAgentToolPayloadSchema = Type.Object(
  {
    toolCallId: BoundedString(128),
    toolName: BoundedString(128),
    state: Type.Union([Type.Literal("running"), Type.Literal("complete")]),
    isError: Type.Optional(Type.Boolean()),
    label: Type.Optional(BoundedString(128)),
    summary: Type.Optional(BoundedString(512)),
  },
  { additionalProperties: false },
);

export const PiOscAgentAlertPayloadSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("provider"), Type.Literal("runtime")]),
    title: BoundedString(128),
    body: BoundedString(512),
    severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
    statusCode: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const PiOscAgentCompactionPayloadSchema = Type.Object(
  {
    state: Type.Union([Type.Literal("preparing"), Type.Literal("complete")]),
  },
  { additionalProperties: false },
);

export type PiOscHelloPayload = Static<typeof PiOscHelloPayloadSchema>;
export type PiOscAgentSessionPayload = Static<typeof PiOscAgentSessionPayloadSchema>;
export type PiOscAgentRunPayload = Static<typeof PiOscAgentRunPayloadSchema>;
export type PiOscAgentTurnPayload = Static<typeof PiOscAgentTurnPayloadSchema>;
export type PiOscAgentProgressPayload = Static<typeof PiOscAgentProgressPayloadSchema>;
export type PiOscAgentToolPayload = Static<typeof PiOscAgentToolPayloadSchema>;
export type PiOscAgentAlertPayload = Static<typeof PiOscAgentAlertPayloadSchema>;
export type PiOscAgentCompactionPayload = Static<typeof PiOscAgentCompactionPayloadSchema>;

export type PiOscV1Payload =
  | PiOscHelloPayload
  | PiOscAgentSessionPayload
  | PiOscAgentRunPayload
  | PiOscAgentTurnPayload
  | PiOscAgentProgressPayload
  | PiOscAgentToolPayload
  | PiOscAgentAlertPayload
  | PiOscAgentCompactionPayload;

export const getPiOscPayloadSchema = (eventName: PiOscV1Event): TSchema => {
  switch (eventName) {
    case "hello":
      return PiOscHelloPayloadSchema;
    case "agent.session":
      return PiOscAgentSessionPayloadSchema;
    case "agent.run":
      return PiOscAgentRunPayloadSchema;
    case "agent.turn":
      return PiOscAgentTurnPayloadSchema;
    case "agent.progress":
      return PiOscAgentProgressPayloadSchema;
    case "agent.tool":
      return PiOscAgentToolPayloadSchema;
    case "agent.alert":
      return PiOscAgentAlertPayloadSchema;
    case "agent.compaction":
      return PiOscAgentCompactionPayloadSchema;
  }

  const _unreachable: never = eventName;
  throw new Error("Unsupported Pi OSC event");
};

export const isValidPiOscPayload = (eventName: PiOscV1Event, payload: unknown): boolean =>
  Value.Check(getPiOscPayloadSchema(eventName), payload);
