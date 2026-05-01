import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toJsonValue } from "../json-value.js";
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
    parameters: toJsonValue(definition.parameters) ?? {},
    renderShell: definition.renderShell,
    executionMode: definition.executionMode,
    sourceInfo: toJsonValue(sourceInfo),
  };
}
