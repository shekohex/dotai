import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../extensions/session-replacement.js";

import {
  STRUCTURED_OUTPUT_FINAL_TOOL_ERROR,
  buildStructuredOutputError,
  buildStructuredOutputRetryPrompt,
  persistStructuredOutputState,
  type ChildBootstrapRuntimeState,
} from "./bootstrap-core.js";

function sendUserMessageSafely(pi: ExtensionAPI, prompt: string): void {
  try {
    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
  }
}

function persistCapturedStructuredOutput(
  pi: ExtensionAPI,
  state: ChildBootstrapRuntimeState,
  captured: unknown,
): void {
  state.structuredState.captured = captured;
  persistStructuredOutputState(pi, {
    status: "captured",
    attempts: state.structuredState.attempts,
    retryCount: state.structuredState.retryCount,
    structured: captured,
    updatedAt: Date.now(),
  });
  state.structuredState.completed = true;
}

function persistStructuredRetrying(pi: ExtensionAPI, state: ChildBootstrapRuntimeState): void {
  persistStructuredOutputState(pi, {
    status: "retrying",
    attempts: state.structuredState.attempts,
    retryCount: state.structuredState.retryCount,
    updatedAt: Date.now(),
  });
  setTimeout(() => {
    sendUserMessageSafely(pi, buildStructuredOutputRetryPrompt(state.structuredState));
  }, 0);
}

function persistStructuredFailure(pi: ExtensionAPI, state: ChildBootstrapRuntimeState): void {
  const hasValidationError =
    state.structuredState.lastValidationError !== undefined &&
    state.structuredState.lastValidationError.length > 0;
  const error = buildStructuredOutputError(
    hasValidationError ? "validation_failed" : "missing_tool_call",
    hasValidationError
      ? "Structured output validation failed and retry budget was exhausted."
      : "Model did not call StructuredOutput before retry budget was exhausted.",
    state.structuredState,
  );
  persistStructuredOutputState(pi, {
    status: "error",
    attempts: state.structuredState.attempts,
    retryCount: state.structuredState.retryCount,
    error,
    updatedAt: Date.now(),
  });
  state.structuredState.completed = true;
}

export function updateStructuredTurnStateFromResults(
  toolResults: Array<{ toolName: string; isError: boolean }>,
  state: ChildBootstrapRuntimeState,
  structuredOutputToolName: string,
): void {
  const successfulStructuredCalls = toolResults.filter(
    (toolResult) => toolResult.toolName === structuredOutputToolName && !toolResult.isError,
  ).length;
  const nonStructuredCalls = toolResults.filter(
    (toolResult) => toolResult.toolName !== structuredOutputToolName,
  ).length;
  if (successfulStructuredCalls > 0) {
    const isSoleStructuredCall = successfulStructuredCalls === 1 && nonStructuredCalls === 0;
    if (
      isSoleStructuredCall &&
      state.turnStructuredCaptured &&
      state.turnStructuredPayload !== undefined
    ) {
      state.lastTurnStructuredCaptured = true;
      state.lastTurnStructuredPayload = state.turnStructuredPayload;
      state.lastTurnStructuredValidationError = undefined;
      return;
    }
    state.lastTurnStructuredCaptured = false;
    state.lastTurnStructuredPayload = undefined;
    state.lastTurnStructuredValidationError =
      state.turnStructuredValidationError ?? STRUCTURED_OUTPUT_FINAL_TOOL_ERROR;
    return;
  }
  if (toolResults.length === 0) {
    if (
      state.turnStructuredValidationError !== undefined &&
      state.turnStructuredValidationError.length > 0
    ) {
      state.lastTurnStructuredValidationError = state.turnStructuredValidationError;
    }
    return;
  }
  state.lastTurnStructuredCaptured = false;
  state.lastTurnStructuredPayload = undefined;
  state.lastTurnStructuredValidationError = state.turnStructuredValidationError;
}

export function handleStructuredAgentEnd(
  pi: ExtensionAPI,
  state: ChildBootstrapRuntimeState,
): "shutdown" | "retry" | "continue" {
  if (!state.structuredState.enabled || state.structuredState.completed) {
    return "continue";
  }
  if (state.lastTurnStructuredCaptured && state.lastTurnStructuredPayload !== undefined) {
    persistCapturedStructuredOutput(pi, state, state.lastTurnStructuredPayload);
    return "shutdown";
  }
  if (
    state.lastTurnStructuredValidationError !== undefined &&
    state.lastTurnStructuredValidationError.length > 0
  ) {
    state.structuredState.lastValidationError = state.lastTurnStructuredValidationError;
  }
  state.structuredState.attempts += 1;
  if (state.structuredState.attempts < state.structuredState.retryCount) {
    persistStructuredRetrying(pi, state);
    return "retry";
  }
  persistStructuredFailure(pi, state);
  return "shutdown";
}
