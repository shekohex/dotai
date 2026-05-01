import { Type } from "typebox";

export const RuntimeAgentSessionEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("agent_start") }),
  Type.Object({ type: Type.Literal("turn_start") }),
  Type.Object({ type: Type.Literal("agent_end"), messages: Type.Array(Type.Unknown()) }),
  Type.Object({
    type: Type.Literal("turn_end"),
    message: Type.Unknown(),
    toolResults: Type.Array(Type.Unknown()),
  }),
  Type.Object({ type: Type.Literal("message_start"), message: Type.Unknown() }),
  Type.Object({ type: Type.Literal("message_end"), message: Type.Unknown() }),
  Type.Object({
    type: Type.Literal("message_update"),
    message: Type.Unknown(),
    assistantMessageEvent: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal("tool_execution_start"),
    toolCallId: Type.String(),
    toolName: Type.String(),
    args: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal("tool_execution_update"),
    toolCallId: Type.String(),
    toolName: Type.String(),
    args: Type.Unknown(),
    partialResult: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal("tool_execution_end"),
    toolCallId: Type.String(),
    toolName: Type.String(),
    isError: Type.Boolean(),
    result: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal("queue_update"),
    steering: Type.Array(Type.String()),
    followUp: Type.Array(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("compaction_start"),
    reason: Type.Union([
      Type.Literal("manual"),
      Type.Literal("threshold"),
      Type.Literal("overflow"),
    ]),
  }),
  Type.Object({
    type: Type.Literal("compaction_end"),
    reason: Type.Union([
      Type.Literal("manual"),
      Type.Literal("threshold"),
      Type.Literal("overflow"),
    ]),
    result: Type.Optional(Type.Unknown()),
    aborted: Type.Boolean(),
    willRetry: Type.Boolean(),
    errorMessage: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("auto_retry_start"),
    attempt: Type.Number(),
    maxAttempts: Type.Number(),
    delayMs: Type.Number(),
    errorMessage: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("auto_retry_end"),
    success: Type.Boolean(),
    attempt: Type.Number(),
    finalError: Type.Optional(Type.String()),
  }),
]);
