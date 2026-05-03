import { Type } from "typebox";
import { Value } from "typebox/value";
import type { JsonValue } from "../../json-schema.js";
import { JsonValueSchema } from "../../json-schema.js";

const CanonicalToolResultSchema = Type.Object({
  content: Type.Array(JsonValueSchema),
  details: Type.Optional(JsonValueSchema),
});

export type CanonicalToolResult = {
  content: JsonValue[];
  details?: JsonValue;
};

export function normalizeToolResultForAgentEvent(
  value: JsonValue | undefined,
): CanonicalToolResult {
  if (Value.Check(CanonicalToolResultSchema, value)) {
    return {
      content: [...value.content],
      ...(Object.prototype.hasOwnProperty.call(value, "details") ? { details: value.details } : {}),
    };
  }

  return {
    content: [],
    ...(value === undefined ? {} : { details: value }),
  };
}
