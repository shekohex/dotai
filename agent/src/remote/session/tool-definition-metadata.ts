import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
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
  const jsonValue = toJsonObjectValue(value);
  if (jsonValue !== undefined) {
    return jsonValue;
  }
  throw new Error("Tool definition parameters must be JSON object");
}

function toOptionalJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const jsonValue = toJsonObjectValue(value);
  if (jsonValue !== undefined) {
    return jsonValue;
  }
  throw new Error("Tool definition sourceInfo must be JSON object");
}

function toJsonObjectValue(value: unknown): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result: JsonObject = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue === undefined) {
      continue;
    }

    const nextValue = toJsonCompatibleValue(entryValue);
    if (nextValue === undefined) {
      return undefined;
    }
    result[key] = nextValue;
  }

  return isJsonObject(result) ? result : undefined;
}

function toJsonCompatibleValue(value: unknown): JsonObject[string] | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const result: JsonObject[string] = [];
    for (const entryValue of value) {
      const nextValue = toJsonCompatibleValue(entryValue);
      if (nextValue === undefined) {
        return undefined;
      }
      result.push(nextValue);
    }
    return result;
  }

  return toJsonObjectValue(value);
}
