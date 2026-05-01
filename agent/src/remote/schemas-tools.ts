import { Type } from "typebox";
import { JsonObjectSchema } from "./schemas-session-runtime.js";

export const ToolDefinitionMetadataSchema = Type.Object({
  name: Type.String(),
  label: Type.String(),
  description: Type.String(),
  promptSnippet: Type.Optional(Type.String()),
  promptGuidelines: Type.Optional(Type.Array(Type.String())),
  parameters: JsonObjectSchema,
  renderShell: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("self")])),
  executionMode: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("parallel")])),
  sourceInfo: Type.Optional(JsonObjectSchema),
});

export const RemoteToolInfoSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  parameters: JsonObjectSchema,
  sourceInfo: Type.Optional(JsonObjectSchema),
  definition: Type.Optional(ToolDefinitionMetadataSchema),
});

export const SessionToolsResponseSchema = Type.Object({
  tools: Type.Array(RemoteToolInfoSchema),
});
