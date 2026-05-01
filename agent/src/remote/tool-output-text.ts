import { Type } from "typebox";
import { Value } from "typebox/value";
import { JsonValueSchema, type JsonValue } from "./json-schema.js";

const ToolOutputTextShapeSchema = Type.Object({
  content: Type.Tuple([
    Type.Object({
      type: Type.Literal("text"),
      text: Type.String(),
    }),
  ]),
  details: Type.Optional(JsonValueSchema),
});

type ToolOutputTextShape = {
  content: [{ type: "text"; text: string }];
  details?: JsonValue;
};

export function readToolOutputText(value: JsonValue | undefined): string | undefined {
  if (!Value.Check(ToolOutputTextShapeSchema, value)) {
    return undefined;
  }

  return value.content[0].text;
}

export function appendToolOutputTextDelta(
  value: JsonValue | undefined,
  delta: string,
): ToolOutputTextShape | undefined {
  if (!Value.Check(ToolOutputTextShapeSchema, value)) {
    return undefined;
  }

  return {
    ...value,
    content: [{ ...value.content[0], text: `${value.content[0].text}${delta}` }],
  };
}
