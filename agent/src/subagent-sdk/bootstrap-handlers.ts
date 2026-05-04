import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../extensions/session-replacement.js";
import { extractMessageText } from "../extensions/session-launch-utils.js";

import {
  activateAutoExitTimeoutMode,
  consumeParentInjectedInputMarker,
  isAutoExitTimeoutModeActive,
  writeEphemeralChildSessionOutcome,
} from "./persistence.js";
import type { ChildBootstrapState } from "./types.js";
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  applyChildToolState,
  extractToolResultText,
  formatChildSessionDisplayName,
  isChildSession,
  isJsonSchemaOutputFormat,
  type ChildBootstrapRuntimeState,
} from "./bootstrap-core.js";
import {
  handleStructuredAgentEnd,
  updateStructuredTurnStateFromResults,
} from "./bootstrap-structured.js";

function shutdownContextSafely(ctx: ExtensionContext): void {
  try {
    ctx.shutdown();
  } catch (error) {
    if (!isStaleSessionReplacementContextError(error)) {
      throw error;
    }
  }
}

function cancelIdleShutdown(state: ChildBootstrapRuntimeState): void {
  if (!state.pendingIdleShutdown) {
    return;
  }
  clearTimeout(state.pendingIdleShutdown);
  state.pendingIdleShutdown = undefined;
}

function scheduleIdleShutdown(
  state: ChildBootstrapRuntimeState,
  ctx: ExtensionContext,
  currentChildState: ChildBootstrapState,
): void {
  cancelIdleShutdown(state);
  if (!state.timeoutModeActive) {
    shutdownContextSafely(ctx);
    return;
  }
  state.pendingIdleShutdown = setTimeout(() => {
    state.pendingIdleShutdown = undefined;
    if (!state.autoExitEnabled || !isChildSession(currentChildState, ctx)) {
      return;
    }
    shutdownContextSafely(ctx);
  }, currentChildState.autoExitTimeoutMs ?? 30_000);
  state.pendingIdleShutdown.unref?.();
}

function resetTurnStructuredState(state: ChildBootstrapRuntimeState): void {
  state.turnStructuredCaptured = false;
  state.turnStructuredPayload = undefined;
  state.turnStructuredValidationError = undefined;
}

function resetLastTurnStructuredState(state: ChildBootstrapRuntimeState): void {
  state.lastTurnStructuredCaptured = false;
  state.lastTurnStructuredPayload = undefined;
  state.lastTurnStructuredValidationError = undefined;
}

function registerChildSessionStartHandler(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
): void {
  pi.on("session_start", (_event, ctx) => {
    if (!isChildSession(childState, ctx)) {
      return;
    }
    state.timeoutModeActive = isAutoExitTimeoutModeActive(childState.sessionId);
    applyChildToolState(pi, childState);
    pi.setSessionName(formatChildSessionDisplayName(childState.name, childState.prompt));
    if (!ctx.hasUI) {
      return;
    }
    ctx.ui.onTerminalInput((data) => {
      if (!state.autoExitEnabled || data.trim().length === 0) {
        return;
      }
      if (consumeParentInjectedInputMarker(childState.sessionId)) {
        return;
      }
      state.timeoutModeActive = true;
      activateAutoExitTimeoutMode(childState.sessionId);
      cancelIdleShutdown(state);
    });
  });
}

function registerChildBeforeAgentStartHandler(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
  structuredOutputSystemPrompt: string,
): void {
  pi.on("before_agent_start", (event, ctx): { systemPrompt: string } => {
    if (!isChildSession(childState, ctx)) {
      return { systemPrompt: event.systemPrompt };
    }
    cancelIdleShutdown(state);
    applyChildToolState(pi, childState);
    resetTurnStructuredState(state);
    resetLastTurnStructuredState(state);
    if (!isJsonSchemaOutputFormat(childState) || state.structuredState.completed) {
      return { systemPrompt: event.systemPrompt };
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${structuredOutputSystemPrompt}`,
    };
  });
}

function registerChildToolResultHandler(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
): void {
  pi.on("tool_result", (event, ctx) => {
    if (!isChildSession(childState, ctx) || !isJsonSchemaOutputFormat(childState)) {
      return;
    }
    if (event.toolName !== STRUCTURED_OUTPUT_TOOL_NAME || !event.isError) {
      return;
    }
    state.turnStructuredValidationError =
      extractToolResultText(event.content) ?? "Structured output tool validation failed.";
  });
}

function registerChildTurnHandlers(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
): void {
  pi.on("turn_start", (_event, ctx) => {
    if (!isChildSession(childState, ctx) || !isJsonSchemaOutputFormat(childState)) {
      return;
    }
    resetTurnStructuredState(state);
  });
  pi.on("turn_end", (event, ctx) => {
    if (!isChildSession(childState, ctx) || !isJsonSchemaOutputFormat(childState)) {
      return;
    }
    updateStructuredTurnStateFromResults(event.toolResults, state, STRUCTURED_OUTPUT_TOOL_NAME);
  });
}

function registerChildAgentEndHandler(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
): void {
  pi.on("agent_end", (event, ctx) => {
    if (!isChildSession(childState, ctx)) {
      return;
    }
    const result = handleStructuredAgentEnd(pi, state);
    if (childState.persisted === false) {
      writeEphemeralChildSessionOutcome(
        childState.sessionId,
        buildEphemeralChildOutcome(result, event.messages, state),
      );
    }
    if (result === "shutdown") {
      shutdownContextSafely(ctx);
      return;
    }
    if (result === "retry") {
      return;
    }
    if (!state.autoExitEnabled) {
      return;
    }
    scheduleIdleShutdown(state, ctx, childState);
  });
}

function buildEphemeralChildOutcome(
  result: "shutdown" | "retry" | "continue",
  messages: Array<{ role?: string; content?: unknown }>,
  state: ChildBootstrapRuntimeState,
): {
  summary?: string;
  structured?: unknown;
  structuredError?: {
    code: "validation_failed";
    message: string;
    retryCount: number;
    attempts: number;
    lastValidationError: string;
  };
  failed: boolean;
} {
  const lastValidationError = state.structuredState.lastValidationError;
  const structuredError =
    lastValidationError !== undefined && lastValidationError.length > 0 && result !== "retry"
      ? {
          code: "validation_failed" as const,
          message: lastValidationError,
          retryCount: state.structuredState.retryCount,
          attempts: state.structuredState.attempts,
          lastValidationError,
        }
      : undefined;

  return {
    summary: getLatestAssistantSummary(messages),
    structured: state.structuredState.captured,
    structuredError,
    failed: structuredError !== undefined,
  };
}

function getLatestAssistantSummary(
  messages: Array<{ role?: string; content?: unknown }>,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (typeof content === "string") {
      const text = content.trim();
      return text.length > 0 ? text : undefined;
    }
    if (isTextContentArray(content)) {
      const text = extractMessageText(content);
      return text.length > 0 ? text : undefined;
    }
  }

  return undefined;
}

function isTextContentArray(value: unknown): value is Array<{ type: string; text?: string }> {
  return Array.isArray(value);
}

function registerChildSessionShutdownHandler(
  pi: ExtensionAPI,
  state: ChildBootstrapRuntimeState,
): void {
  pi.on("session_shutdown", () => {
    cancelIdleShutdown(state);
  });
}

export function registerChildBootstrapHandlers(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
  structuredOutputSystemPrompt: string,
): void {
  registerChildSessionStartHandler(pi, childState, state);
  registerChildBeforeAgentStartHandler(pi, childState, state, structuredOutputSystemPrompt);
  registerChildToolResultHandler(pi, childState, state);
  registerChildTurnHandlers(pi, childState, state);
  registerChildAgentEndHandler(pi, childState, state);
  registerChildSessionShutdownHandler(pi, state);
}
