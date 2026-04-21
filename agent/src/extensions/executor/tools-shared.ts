import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { JsonObject, JsonValue } from "./http.js";
import type { ResumeAction } from "./mcp-client.js";
import type { ExecuteToolDetails } from "./executor-adapter.js";

export const jsonStringSchema = Type.String({
  description: "Optional JSON-encoded response content",
});

export const EXECUTE_STREAM_TAIL_LINES = 5;
export const EXECUTE_SUMMARY_LINE_LIMIT = 80;
export const TOOL_TEXT_PADDING_X = 0;
export const TOOL_TEXT_PADDING_Y = 0;
export const EXECUTE_TAB_WIDTH = 2;

export const executeToolParams = Type.Object({
  description: Type.String({
    description: "Clear, concise description of what this code does in 5-10 words.",
  }),
  code: Type.String({ description: "JavaScript code to execute" }),
});

export type ExecuteToolInput = {
  description: string;
  code: string;
};

export type ExecuteRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  callComponent?: unknown;
  callText?: string;
};

export type ExecuteToolRenderContext = {
  state: unknown;
  executionStarted: boolean;
  invalidate: () => void;
  isError: boolean;
  isPartial: boolean;
  argsComplete: boolean;
  expanded: boolean;
  lastComponent: unknown;
};

export type ExecutorRenderTheme = Theme;

const ExecutorSearchResultItemSchema = Type.Object({
  path: Type.String(),
  name: Type.String(),
  description: Type.String(),
  sourceId: Type.String(),
  score: Type.Number(),
});

const ExecutorSearchResultsSchema = Type.Array(ExecutorSearchResultItemSchema, { minItems: 1 });

export type ExecutorSearchResultItem = Static<typeof ExecutorSearchResultItemSchema>;

const ResumeActionSchema = Type.Union([
  Type.Literal("accept"),
  Type.Literal("decline"),
  Type.Literal("cancel"),
]);

export const isJsonValue = (value: unknown): value is JsonValue => {
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

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);

export const resolveResumeAction = (value: unknown): ResumeAction => {
  if (!Value.Check(ResumeActionSchema, value)) {
    return "cancel";
  }

  return Value.Parse(ResumeActionSchema, value);
};

export const isExecuteRenderState = (value: unknown): value is ExecuteRenderState =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const hasStructuredContentDetails = (value: unknown): value is ExecuteToolDetails =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  "structuredContent" in value;

const isExecutorSearchResults = (
  value: JsonValue | undefined,
): value is ExecutorSearchResultItem[] =>
  value !== undefined && Value.Check(ExecutorSearchResultsSchema, value);

export const parseExecutorSearchResults = (
  value: JsonValue | undefined,
): ExecutorSearchResultItem[] | undefined => {
  if (!isExecutorSearchResults(value)) {
    return undefined;
  }

  return Value.Parse(ExecutorSearchResultsSchema, value);
};
