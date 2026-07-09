import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { parseJsonValue } from "./json.js";

const GhIssueViewSchema = Type.Object({
  id: Type.Optional(Type.String()),
  number: Type.Number({ minimum: 1 }),
  state: Type.Union([Type.Literal("OPEN"), Type.Literal("CLOSED")]),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  url: Type.String(),
  labels: Type.Array(Type.Object({ name: Type.String() })),
  assignees: Type.Array(Type.Object({ login: Type.String() })),
});

export function parseGhIssueView(stdout: string): Static<typeof GhIssueViewSchema> {
  return Value.Parse(GhIssueViewSchema, parseJsonValue(stdout, "gh issue view"));
}
