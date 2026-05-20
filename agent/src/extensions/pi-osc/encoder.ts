import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const ESC = "\u001B";
const ST = `${ESC}\\`;
const BEL = "\u0007";
const PI_OSC_MAX_BYTES = 8192;

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

export const PiOscEnvelopeSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    ts: Type.Number(),
    source: Type.Literal("agent"),
    data: Type.Record(Type.String(), Type.Unknown()),
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

type PiOscJsonValue = null | boolean | number | string | PiOscJsonArray | PiOscJsonObject;

interface PiOscJsonArray extends Array<PiOscJsonValue> {}

interface PiOscJsonObject {
  [key: string]: PiOscJsonValue;
}

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const normalizePiOscJsonObject = (
  value: Record<string, unknown>,
  seen: WeakSet<object>,
): PiOscJsonObject => {
  if (seen.has(value)) {
    throw new PiOscEncodingError("Invalid Pi OSC envelope data");
  }

  if (Object.getOwnPropertyNames(value).includes("toJSON")) {
    throw new PiOscEncodingError("Invalid Pi OSC envelope data");
  }

  seen.add(value);
  try {
    const normalized: PiOscJsonObject = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (
        descriptor.enumerable !== true ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new PiOscEncodingError("Invalid Pi OSC envelope data");
      }

      Object.defineProperty(normalized, key, {
        value: normalizePiOscJsonValue(descriptor.value, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
};

const normalizePiOscJsonValue = (value: unknown, seen = new WeakSet<object>()): PiOscJsonValue => {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new PiOscEncodingError("Invalid Pi OSC envelope data");
    }

    return value;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new PiOscEncodingError("Invalid Pi OSC envelope data");
    }

    const allowedProperties = new Set(["length", ...Object.keys(value)]);
    if (Object.getOwnPropertyNames(value).some((property) => !allowedProperties.has(property))) {
      throw new PiOscEncodingError("Invalid Pi OSC envelope data");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(value)) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new PiOscEncodingError("Invalid Pi OSC envelope data");
      }
    }

    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new PiOscEncodingError("Invalid Pi OSC envelope data");
      }
    }

    seen.add(value);
    try {
      return value.map((item) => normalizePiOscJsonValue(item, seen));
    } finally {
      seen.delete(value);
    }
  }

  if (typeof value === "object") {
    if (!isPlainRecord(value) || seen.has(value)) {
      throw new PiOscEncodingError("Invalid Pi OSC envelope data");
    }

    return normalizePiOscJsonObject(value, seen);
  }

  throw new PiOscEncodingError("Invalid Pi OSC envelope data");
};

const isPiOscEnvelope = (value: unknown): value is PiOscEnvelope => {
  try {
    return Value.Check(PiOscEnvelopeSchema, value);
  } catch {
    return false;
  }
};

export const createPiOscSequence = (
  eventName: string,
  envelope: unknown,
  terminator: PiOscTerminator = "st",
): string => {
  if (!isPiOscV1Event(eventName)) {
    throw new PiOscEncodingError(`Unsupported Pi OSC event: ${eventName}`);
  }

  if (!isPiOscEnvelope(envelope)) {
    throw new PiOscEncodingError("Invalid Pi OSC envelope");
  }

  if (!isPlainRecord(envelope.data)) {
    throw new PiOscEncodingError("Invalid Pi OSC envelope data");
  }

  const serializableEnvelope: PiOscEnvelope = {
    ...envelope,
    data: normalizePiOscJsonObject(envelope.data, new WeakSet<object>()),
  };
  const payload = Buffer.from(JSON.stringify(serializableEnvelope), "utf8").toString("base64url");
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
