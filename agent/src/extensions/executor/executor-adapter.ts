import type { JsonObject, JsonValue } from "./http.js";

export type ExecuteToolDetails = {
  baseUrl: string;
  scopeId: string;
  structuredContent: JsonValue;
  isError: boolean;
  executionId?: string;
  durationMs?: number;
};

export type ExecuteToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ExecuteToolDetails;
};

type ExecutorToolOutcome = {
  text: string;
  structuredContent: JsonValue;
  isError: boolean;
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (typeof value === "object") {
    return Object.values(value).every((item) => isJsonValue(item));
  }

  return false;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readExecutionId = (structuredContent: JsonValue): string | undefined => {
  if (!isJsonObject(structuredContent)) {
    return undefined;
  }

  return structuredContent.status === "waiting_for_interaction" &&
    typeof structuredContent.executionId === "string"
    ? structuredContent.executionId
    : undefined;
};

export const parseJsonContent = (raw: string | undefined): JsonObject | undefined => {
  if (raw === undefined || raw.length === 0 || raw === "{}") {
    return undefined;
  }

  let parsed: JsonValue;
  try {
    const candidate: unknown = JSON.parse(raw);
    if (!isJsonValue(candidate)) {
      return undefined;
    }
    parsed = candidate;
  } catch {
    return undefined;
  }

  return isJsonObject(parsed) ? parsed : undefined;
};

export const toToolResult = (
  outcome: ExecutorToolOutcome,
  meta: { baseUrl: string; scopeId: string; durationMs?: number },
): ExecuteToolResult => ({
  content: [{ type: "text", text: outcome.text }],
  details: {
    baseUrl: meta.baseUrl,
    scopeId: meta.scopeId,
    structuredContent: outcome.structuredContent,
    isError: outcome.isError,
    executionId: readExecutionId(outcome.structuredContent),
    durationMs: meta.durationMs,
  },
});

export const buildExecutorSystemPrompt = (description: string, hasResume: boolean): string =>
  [
    "Executor MCP parity guidance:",
    description,
    "",
    hasResume
      ? "This Pi session has no managed elicitation path available. If execute returns waiting_for_interaction, call resume with the exact executionId."
      : "This Pi session has UI available. Use execute for Executor work and let it handle any interaction inline. Do not call resume unless execute explicitly cannot complete inline.",
  ].join("\n");
