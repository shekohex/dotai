import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const SubagentParentMessageKindSchema = Type.Union([
  Type.Literal("commentary"),
  Type.Literal("progress"),
  Type.Literal("result"),
  Type.Literal("blocker"),
  Type.Literal("decision"),
  Type.Literal("question"),
]);

export const SubagentParentMessageSchema = Type.Object(
  {
    kind: SubagentParentMessageKindSchema,
    message: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
    delivery: Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
    createdAt: Type.Number(),
  },
  { additionalProperties: false },
);

export const SubagentParentMessageToolParamsSchema = Type.Object(
  {
    action: Type.Literal("message", {
      description: "Send an explicit message from this child thread to its parent session.",
    }),
    target: Type.Literal("parent", {
      description: "Parent coordinator session that launched this subagent.",
    }),
    kind: Type.Optional(SubagentParentMessageKindSchema),
    message: Type.String({
      minLength: 1,
      maxLength: 32 * 1024,
      description:
        "Concise update for the parent: useful progress, a blocker, a decision or question, or the result. Do not send raw chain-of-thought.",
    }),
    delivery: Type.Optional(
      Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
        description:
          "Defaults to steer, which reaches the parent immediately. Use followUp only when the update should wait for the parent's current turn.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type SubagentParentMessageKind = Static<typeof SubagentParentMessageKindSchema>;
export type SubagentParentMessage = Static<typeof SubagentParentMessageSchema>;
export type SubagentParentMessageToolParams = Static<typeof SubagentParentMessageToolParamsSchema>;

export function parseSubagentParentMessage(value: unknown): SubagentParentMessage | undefined {
  return Value.Check(SubagentParentMessageSchema, value)
    ? Value.Parse(SubagentParentMessageSchema, value)
    : undefined;
}
