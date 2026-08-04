import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const ViewImageDetailsSchema = Type.Object(
  {
    path: Type.String(),
    phase: Type.Optional(Type.Union([Type.Literal("loading"), Type.Literal("describing")])),
    mimeType: Type.Optional(Type.String()),
    byteSize: Type.Optional(Type.Number({ minimum: 0 })),
    describedBy: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type ViewImageDetails = Static<typeof ViewImageDetailsSchema>;

export function parseViewImageDetails(value: unknown): ViewImageDetails | undefined {
  return Value.Check(ViewImageDetailsSchema, value)
    ? Value.Parse(ViewImageDetailsSchema, value)
    : undefined;
}
