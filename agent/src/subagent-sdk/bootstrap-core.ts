import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import {
  isAutoExitTimeoutModeActive,
  readLatestChildStructuredOutputState,
} from "./persistence.js";
import {
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  serializeSubagentStructuredOutputEntry,
  type ChildBootstrapState,
  type StructuredOutputError,
} from "./types.js";

export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";
export const DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT = 3;
export const STRUCTURED_OUTPUT_SYSTEM_PROMPT =
  "IMPORTANT: You MUST call the StructuredOutput tool as your final response. Do not respond with plain text for the final answer.";
export const STRUCTURED_OUTPUT_FINAL_TOOL_ERROR =
  "StructuredOutput must be the only tool call in the final turn.";

export type StructuredOutputState = {
  enabled: boolean;
  retryCount: number;
  attempts: number;
  captured?: unknown;
  lastValidationError?: string;
  completed: boolean;
};

export type ChildBootstrapRuntimeState = {
  structuredState: StructuredOutputState;
  autoExitEnabled: boolean;
  timeoutModeActive: boolean;
  turnStructuredCaptured: boolean;
  turnStructuredPayload: unknown;
  turnStructuredValidationError: string | undefined;
  lastTurnStructuredCaptured: boolean;
  lastTurnStructuredPayload: unknown;
  lastTurnStructuredValidationError: string | undefined;
  pendingIdleShutdown: ReturnType<typeof setTimeout> | undefined;
};

export function isJsonSchemaOutputFormat(
  childState: ChildBootstrapState | undefined,
): childState is ChildBootstrapState & {
  outputFormat: { type: "json_schema"; schema: unknown; retryCount?: number };
} {
  return childState?.outputFormat?.type === "json_schema";
}

function getStructuredRetryCount(childState: ChildBootstrapState | undefined): number {
  if (!isJsonSchemaOutputFormat(childState)) {
    return 0;
  }
  const requested = childState.outputFormat.retryCount;
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT;
  }
  return Math.max(0, Math.floor(requested));
}

export function buildStructuredOutputError(
  code: StructuredOutputError["code"],
  message: string,
  state: StructuredOutputState,
): StructuredOutputError {
  return {
    code,
    message,
    retryCount: state.retryCount,
    attempts: state.attempts,
    lastValidationError: state.lastValidationError,
  };
}

export function persistStructuredOutputState(
  pi: ExtensionAPI,
  payload: Parameters<typeof serializeSubagentStructuredOutputEntry>[0],
): void {
  pi.appendEntry(
    SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
    serializeSubagentStructuredOutputEntry({
      ...payload,
      updatedAt: payload.updatedAt,
    }),
  );
}

export function buildStructuredOutputRetryPrompt(state: StructuredOutputState): string {
  const retriesLeft = Math.max(0, state.retryCount - state.attempts);
  const suffix =
    state.lastValidationError !== undefined && state.lastValidationError.length > 0
      ? ` Last validation error: ${state.lastValidationError}`
      : "";
  return `You must call the ${STRUCTURED_OUTPUT_TOOL_NAME} tool with output that matches the schema exactly. Do not end with plain text. Retries left: ${retriesLeft}.${suffix}`;
}

export function extractToolResultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const chunks = content
    .map((part) => readTextChunk(part))
    .join("\n")
    .trim();
  return chunks.length > 0 ? chunks : undefined;
}

function readTextChunk(part: unknown): string {
  if (part === null || typeof part !== "object" || Array.isArray(part)) {
    return "";
  }

  const text = "text" in part ? part.text : undefined;
  return typeof text === "string" ? text : "";
}

export function isTypeboxSchema(value: unknown): value is TSchema {
  return value !== null && typeof value === "object";
}

function normalizeSingleLine(value: string): string {
  let normalized = "";
  let previousWasWhitespace = false;
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    const isControl = codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    const isWhitespace = isControl || /\s/.test(char);
    if (isWhitespace) {
      if (!previousWasWhitespace) {
        normalized += " ";
        previousWasWhitespace = true;
      }
      continue;
    }
    normalized += char;
    previousWasWhitespace = false;
  }
  return normalized.trim();
}

export function formatChildSessionDisplayName(name: string, prompt: string): string {
  const normalizedPrompt = normalizeSingleLine(prompt);
  return normalizedPrompt ? `[${name}] ${normalizedPrompt}` : `[${name}]`;
}

export function applyChildToolState(
  pi: ExtensionAPI,
  childState: ChildBootstrapState | undefined,
): void {
  if (!childState) {
    return;
  }
  const activeTools = new Set(childState.tools);
  activeTools.delete("subagent");
  if (isJsonSchemaOutputFormat(childState)) {
    activeTools.add(STRUCTURED_OUTPUT_TOOL_NAME);
  }
  pi.setActiveTools(Array.from(activeTools).toSorted((left, right) => left.localeCompare(right)));
}

export function isChildSession(
  childState: ChildBootstrapState | undefined,
  ctx: ExtensionContext,
): childState is ChildBootstrapState {
  if (!childState) {
    return false;
  }
  return (
    ctx.sessionManager.getSessionId() === childState.sessionId ||
    ctx.sessionManager.getSessionFile() === childState.sessionPath
  );
}

export function createChildBootstrapRuntimeState(
  childState: ChildBootstrapState,
): ChildBootstrapRuntimeState {
  const restoredStructuredState = readLatestChildStructuredOutputState(childState.sessionPath);
  const structuredRetryCount = getStructuredRetryCount(childState);
  return {
    structuredState: {
      enabled: isJsonSchemaOutputFormat(childState),
      retryCount: structuredRetryCount,
      attempts: Math.min(restoredStructuredState?.attempts ?? 0, structuredRetryCount),
      captured: restoredStructuredState?.structured,
      lastValidationError: restoredStructuredState?.error?.lastValidationError,
      completed:
        restoredStructuredState?.status === "captured" ||
        restoredStructuredState?.status === "error",
    },
    autoExitEnabled: childState.autoExit ?? false,
    timeoutModeActive: isAutoExitTimeoutModeActive(childState.sessionId),
    turnStructuredCaptured: false,
    turnStructuredPayload: undefined,
    turnStructuredValidationError: undefined,
    lastTurnStructuredCaptured: false,
    lastTurnStructuredPayload: undefined,
    lastTurnStructuredValidationError: undefined,
    pendingIdleShutdown: undefined,
  };
}
