import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolDefinitionMetadata } from "../../schemas.js";
import { JsonObjectSchema, JsonValueSchema } from "../../json-schema.js";
import { asRecord } from "../../../utils/unknown-data.js";

const ToolSchemaLikeSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    properties: Type.Optional(JsonObjectSchema),
    items: Type.Optional(Type.Union([JsonObjectSchema, Type.Array(JsonObjectSchema)])),
    $ref: Type.Optional(Type.String()),
    anyOf: Type.Optional(Type.Array(JsonObjectSchema)),
    allOf: Type.Optional(Type.Array(JsonObjectSchema)),
    oneOf: Type.Optional(Type.Array(JsonObjectSchema)),
    const: Type.Optional(JsonValueSchema),
    enum: Type.Optional(Type.Array(JsonValueSchema)),
  },
  { additionalProperties: JsonValueSchema },
);

const EmptyToolParametersSchema = Type.Object({});

export function buildRemoteToolDefinition(metadata: ToolDefinitionMetadata): ToolDefinition {
  return {
    name: metadata.name,
    label: metadata.label,
    description: metadata.description,
    promptSnippet: metadata.promptSnippet,
    promptGuidelines: metadata.promptGuidelines,
    parameters: normalizeToolParameters(metadata.parameters),
    renderShell: metadata.renderShell,
    executionMode: metadata.executionMode,
    execute() {
      return Promise.reject(
        new Error(`Remote tool definition metadata for ${metadata.name} is not executable`),
      );
    },
  };
}

function normalizeToolParameters(parameters: unknown): ToolDefinition["parameters"] {
  const schema = parseToolParameterTransportSchema(parameters);
  if (schema !== undefined) {
    return schema;
  }
  return EmptyToolParametersSchema;
}

function parseToolParameterTransportSchema(value: unknown): TSchema | undefined {
  if (!Value.Check(ToolSchemaLikeSchema, value)) {
    return undefined;
  }
  if (!isTypeBoxTransportSchemaObject(value)) {
    return undefined;
  }
  return value;
}

function isTypeBoxTransportSchemaObject(value: unknown): value is TSchema {
  return asRecord(value) !== undefined;
}
