import { Type, type Static } from "typebox";

export const WarpCliAgentEventSchema = Type.Union([
  Type.Literal("session_start"),
  Type.Literal("prompt_submit"),
  Type.Literal("stop"),
  Type.Literal("permission_request"),
  Type.Literal("permission_replied"),
  Type.Literal("question_asked"),
  Type.Literal("tool_complete"),
  Type.Literal("idle_prompt"),
]);

export const WarpCliAgentPayloadSchema = Type.Object({
  v: Type.Number(),
  agent: Type.Literal("pi"),
  event: WarpCliAgentEventSchema,
  session_id: Type.String(),
  cwd: Type.String(),
  project: Type.String(),
  plugin_version: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  response: Type.Optional(Type.String()),
  transcript_path: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  tool_name: Type.Optional(Type.String()),
  tool_input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type WarpCliAgentEvent = Static<typeof WarpCliAgentEventSchema>;
export type WarpCliAgentPayload = Static<typeof WarpCliAgentPayloadSchema>;
export type WarpCliAgentPayloadOptions = Partial<
  Pick<
    WarpCliAgentPayload,
    | "plugin_version"
    | "query"
    | "response"
    | "transcript_path"
    | "summary"
    | "tool_name"
    | "tool_input"
  >
>;
