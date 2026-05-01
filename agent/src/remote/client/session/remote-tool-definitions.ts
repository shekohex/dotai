import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolDefinitionMetadata } from "../../schemas.js";
import { asRecord } from "../../../utils/unknown-data.js";

const ToolSchemaLikeSchema = Type.Object(
  {},
  {
    additionalProperties: true,
  },
);

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
  if (!Value.Check(ToolSchemaLikeSchema, value)) {
    return false;
  }

  const schemaCandidate = asRecord(value);
  if (schemaCandidate === undefined) {
    return false;
  }

  return (
    schemaCandidate.type !== undefined ||
    schemaCandidate.properties !== undefined ||
    schemaCandidate.items !== undefined ||
    schemaCandidate.$ref !== undefined ||
    schemaCandidate.anyOf !== undefined ||
    schemaCandidate.allOf !== undefined ||
    schemaCandidate.oneOf !== undefined ||
    schemaCandidate.const !== undefined ||
    schemaCandidate.enum !== undefined
  );
}
