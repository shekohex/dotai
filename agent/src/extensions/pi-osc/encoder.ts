import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const ESC = "\u001B";
const ST = `${ESC}\\`;
const BEL = "\u0007";
const PI_OSC_MAX_BYTES = 8191;

export const PiOscV1EventSchema = Type.Union([
  Type.Literal("hello"),
  Type.Literal("agent.session"),
  Type.Literal("agent.run"),
  Type.Literal("agent.turn"),
  Type.Literal("agent.progress"),
  Type.Literal("agent.tool"),
  Type.Literal("agent.alert"),
  Type.Literal("agent.compaction"),
]);

export type PiOscV1Event = Static<typeof PiOscV1EventSchema>;

export const PiOscJsonValueSchema = Type.Union([
  Type.Null(),
  Type.Boolean(),
  Type.Number(),
  Type.String(),
  Type.Array(Type.This()),
  Type.Record(Type.String(), Type.This()),
]);

export const PiOscEnvelopeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    ts: Type.Number(),
    source: Type.Literal("agent"),
    data: Type.Record(Type.String(), PiOscJsonValueSchema),
    sessionId: Type.Optional(Type.String({ maxLength: 256 })),
    cwd: Type.Optional(Type.String({ maxLength: 1024 })),
    seq: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export type PiOscEnvelope = Static<typeof PiOscEnvelopeSchema>;

export type PiOscTerminator = "st" | "bel";

export class PiOscEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiOscEncodingError";
  }
}

export const isPiOscV1Event = (eventName: string): eventName is PiOscV1Event =>
  Value.Check(PiOscV1EventSchema, eventName);

export const createPiOscSequence = (
  eventName: string,
  envelope: unknown,
  terminator: PiOscTerminator = "st",
): string => {
  if (!isPiOscV1Event(eventName)) {
    throw new PiOscEncodingError(`Unsupported Pi OSC event: ${eventName}`);
  }

  if (!Value.Check(PiOscEnvelopeSchema, envelope)) {
    throw new PiOscEncodingError("Invalid Pi OSC envelope");
  }

  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const sequence = `${ESC}]6767;pi;1;${eventName};${payload}${terminator === "bel" ? BEL : ST}`;

  if (Buffer.byteLength(sequence, "utf8") >= PI_OSC_MAX_BYTES) {
    throw new PiOscEncodingError("Pi OSC sequence exceeds maximum byte length");
  }

  return sequence;
};

export const createPiOscHelloSequence = (
  envelope: PiOscEnvelope,
  terminator?: PiOscTerminator,
): string => createPiOscSequence("hello", envelope, terminator);

export const createPiOscAgentSessionSequence = (
  envelope: PiOscEnvelope,
  terminator?: PiOscTerminator,
): string => createPiOscSequence("agent.session", envelope, terminator);

export const createPiOscAgentRunSequence = (
  envelope: PiOscEnvelope,
  terminator?: PiOscTerminator,
): string => createPiOscSequence("agent.run", envelope, terminator);

export const createPiOscAgentTurnSequence = (
  envelope: PiOscEnvelope,
  terminator?: PiOscTerminator,
): string => createPiOscSequence("agent.turn", envelope, terminator);

export const createPiOscAgentProgressSequence = (
  envelope: PiOscEnvelope,
  terminator?: PiOscTerminator,
): string => createPiOscSequence("agent.progress", envelope, terminator);

export const createPiOscAgentToolSequence = (
  envelope: PiOscEnvelope,
  terminator?: PiOscTerminator,
): string => createPiOscSequence("agent.tool", envelope, terminator);

export const createPiOscAgentAlertSequence = (
  envelope: PiOscEnvelope,
  terminator?: PiOscTerminator,
): string => createPiOscSequence("agent.alert", envelope, terminator);

export const createPiOscAgentCompactionSequence = (
  envelope: PiOscEnvelope,
  terminator?: PiOscTerminator,
): string => createPiOscSequence("agent.compaction", envelope, terminator);
