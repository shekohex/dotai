import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolDefinitionMetadata } from "../../schemas.js";

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
  if (parameters !== null && typeof parameters === "object") {
    return parameters as TSchema;
  }
  return Type.Object({});
}
