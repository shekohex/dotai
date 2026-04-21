import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { hasRuntimePrimitive } from "../extensions/runtime-capabilities.js";

import {
  activateAutoExitTimeoutMode,
  consumeParentInjectedInputMarker,
  isAutoExitTimeoutModeActive,
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
    ctx.shutdown();
    return;
  }
  state.pendingIdleShutdown = setTimeout(() => {
    state.pendingIdleShutdown = undefined;
    if (!state.autoExitEnabled || !isChildSession(currentChildState, ctx)) {
      return;
    }
    ctx.shutdown();
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
    if (!ctx.hasUI || !hasRuntimePrimitive(ctx, "onTerminalInput")) {
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
  pi.on("agent_end", (_event, ctx) => {
    if (!isChildSession(childState, ctx)) {
      return;
    }
    const result = handleStructuredAgentEnd(pi, state);
    if (result === "shutdown") {
      ctx.shutdown();
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
