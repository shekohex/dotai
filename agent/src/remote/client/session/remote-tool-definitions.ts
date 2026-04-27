import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolDefinitionMetadata } from "../../schemas.js";
import { isRecord } from "../../../utils/unknown-data.js";

export function buildRemoteToolDefinition(
  metadata: ToolDefinitionMetadata,
): ToolDefinition<TSchema, unknown, unknown> {
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

function normalizeToolParameters(parameters: unknown): TSchema {
  if (isToolSchema(parameters)) {
    return parameters;
  }
  return Type.Object({});
}

function isToolSchema(value: unknown): value is TSchema {
  if (!isRecord(value)) {
    return false;
  }

  return (
    "type" in value ||
    "properties" in value ||
    "items" in value ||
    "$ref" in value ||
    "anyOf" in value ||
    "allOf" in value ||
    "oneOf" in value ||
    "const" in value ||
    "enum" in value
  );
}
