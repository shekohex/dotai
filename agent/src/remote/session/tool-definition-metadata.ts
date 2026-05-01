import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toJsonValue } from "../json-value.js";
import { isJsonObject, type JsonObject } from "../json-schema.js";
import type { ToolDefinitionMetadata } from "../schemas.js";

export function serializeToolDefinition(
  definition: ToolDefinition | undefined,
  sourceInfo: unknown,
): ToolDefinitionMetadata | undefined {
  if (!definition) {
    return undefined;
  }

  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    parameters: toJsonObject(definition.parameters),
    renderShell: definition.renderShell,
    executionMode: definition.executionMode,
    sourceInfo: toOptionalJsonObject(sourceInfo),
  };
}

function toJsonObject(value: unknown): JsonObject {
  const jsonValue = toJsonValue(value);
  if (jsonValue !== undefined && isJsonObject(jsonValue)) {
    return jsonValue;
  }
  return {};
}

function toOptionalJsonObject(value: unknown): JsonObject | undefined {
  const jsonValue = toJsonValue(value);
  return jsonValue !== undefined && isJsonObject(jsonValue) ? jsonValue : undefined;
}
