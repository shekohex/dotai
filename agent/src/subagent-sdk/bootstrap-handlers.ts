import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getContextPruneAPI } from "../extensions/context-prune/public-api.js";
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
  persistSubagentActivity,
  type ChildBootstrapRuntimeState,
} from "./bootstrap-core.js";
import {
  handleStructuredAgentEnd,
  persistCapturedStructuredOutput,
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

function requestShutdown(state: ChildBootstrapRuntimeState, ctx: ExtensionContext): void {
  if (state.shutdownRequested) {
    return;
  }
  state.shutdownRequested = true;
  shutdownContextSafely(ctx);
}

function persistActivity(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
  activity: {
    kind: "thinking" | "tool" | "message" | "idle" | "completed" | "failed" | "cancelled";
    label: string;
    detail?: string;
    toolName?: string;
    done: boolean;
  },
): void {
  const now = Date.now();
  const previous = state.lastActivity;
  const startedAt =
    previous &&
    previous.kind === activity.kind &&
    previous.label === activity.label &&
    previous.toolName === activity.toolName
      ? previous.startedAt
      : now;

  const nextActivity = {
    sessionId: childState.sessionId,
    kind: activity.kind,
    label: activity.label,
    detail: activity.detail,
    toolName: activity.toolName,
    startedAt,
    updatedAt: now,
    done: activity.done,
  };

  state.lastActivity = nextActivity;
  persistSubagentActivity(pi, nextActivity);
}

function summarizeActivityText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 160) : undefined;
}

function readToolLabel(toolName: string): string {
  switch (toolName) {
    case "read":
      return "reading";
    case "bash":
      return "running bash";
    case "websearch":
      return "web searching";
    case "write":
      return "writing files";
    case "apply_patch":
      return "applying patch";
    case "edit":
      return "editing files";
    default:
      return `using ${toolName}`;
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
    requestShutdown(state, ctx);
    return;
  }
  state.pendingIdleShutdown = setTimeout(() => {
    state.pendingIdleShutdown = undefined;
    if (!state.autoExitEnabled || !isChildSession(currentChildState, ctx)) {
      return;
    }
    requestShutdown(state, ctx);
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

function getLastAssistantText(
  branch: Array<{ type: string; message?: { role?: string; content?: unknown } }>,
): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message?.role !== "assistant") {
      continue;
    }
    const content = entry.message.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (text.length > 0) {
        return text;
      }
      continue;
    }
    if (isTextContentArray(content)) {
      const text = extractMessageText(content).trim();
      if (text.length > 0) {
        return text;
      }
    }
  }

  return undefined;
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
    const contextPrune = getContextPruneAPI(ctx);
    if (contextPrune !== null && childState.contextPrune !== undefined) {
      contextPrune.updateConfig(childState.contextPrune);
    }
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
    persistActivity(pi, childState, state, {
      kind: "thinking",
      label: "thinking",
      done: false,
    });
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

function registerChildToolCallHandler(
  pi: ExtensionAPI,
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
): void {
  pi.on("tool_call", (event, ctx) => {
    if (!isChildSession(childState, ctx)) {
      return;
    }

    const input = event.input;
    const detail =
      input !== null && typeof input === "object"
        ? summarizeActivityText(JSON.stringify(input))
        : undefined;
    persistActivity(pi, childState, state, {
      kind: "tool",
      label: readToolLabel(event.toolName),
      detail,
      toolName: event.toolName,
      done: false,
    });
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
    state.structuredCaptureInvalidated = true;
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
    if (isChildSession(childState, ctx)) {
      persistActivity(pi, childState, state, {
        kind: "thinking",
        label: "thinking",
        done: false,
      });
    }
    if (!isChildSession(childState, ctx) || !isJsonSchemaOutputFormat(childState)) {
      return;
    }
    resetTurnStructuredState(state);
  });
  pi.on("turn_end", (event, ctx) => {
    if (isChildSession(childState, ctx)) {
      persistActivity(pi, childState, state, {
        kind: "idle",
        label: "waiting",
        detail: getLastAssistantText(ctx.sessionManager.getBranch()),
        done: false,
      });
    }
    if (!isChildSession(childState, ctx) || !isJsonSchemaOutputFormat(childState)) {
      return;
    }
    if (state.structuredState.completed) {
      return;
    }
    updateStructuredTurnStateFromResults(event.toolResults, state, STRUCTURED_OUTPUT_TOOL_NAME);
    const hasStructuredToolResult = event.toolResults.some(
      (toolResult) => toolResult.toolName === STRUCTURED_OUTPUT_TOOL_NAME,
    );
    if (state.lastTurnStructuredCaptured && state.lastTurnStructuredPayload !== undefined) {
      persistCapturedStructuredOutput(pi, state, state.lastTurnStructuredPayload);
      state.structuredCaptureInvalidated = false;
      if (childState.persisted === false) {
        writeEphemeralChildSessionOutcome(childState.sessionId, {
          summary: getLastAssistantText(ctx.sessionManager.getBranch()),
          structured: state.lastTurnStructuredPayload,
          structuredError: undefined,
          failed: false,
        });
      }
      requestShutdown(state, ctx);
      return;
    }
    if (hasStructuredToolResult) {
      state.structuredCaptureInvalidated = true;
    }
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
    persistActivity(pi, childState, state, {
      kind: "completed",
      label: "done",
      detail: getLatestAssistantSummary(event.messages),
      done: true,
    });
    const result = handleStructuredAgentEnd(pi, state);
    if (childState.persisted === false) {
      writeEphemeralChildSessionOutcome(
        childState.sessionId,
        buildEphemeralChildOutcome(result, event.messages, state),
      );
    }
    if (result === "shutdown") {
      requestShutdown(state, ctx);
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
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): string | undefined {
  if (!messages) {
    return undefined;
  }

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
  childState: ChildBootstrapState,
  state: ChildBootstrapRuntimeState,
): void {
  pi.on("session_shutdown", (_event, ctx) => {
    cancelIdleShutdown(state);
    if (!isChildSession(childState, ctx) || childState.persisted !== false) {
      return;
    }

    if (!state.structuredState.completed) {
      handleStructuredAgentEnd(pi, state);
    }

    writeEphemeralChildSessionOutcome(childState.sessionId, {
      summary: getLastAssistantText(ctx.sessionManager.getBranch()),
      structured: state.structuredState.captured,
      structuredError:
        state.structuredState.lastValidationError !== undefined &&
        state.structuredState.lastValidationError.length > 0
          ? {
              code: "validation_failed",
              message: state.structuredState.lastValidationError,
              retryCount: state.structuredState.retryCount,
              attempts: state.structuredState.attempts,
              lastValidationError: state.structuredState.lastValidationError,
            }
          : undefined,
      failed:
        state.structuredState.captured === undefined &&
        (state.structuredState.lastValidationError === undefined ||
          state.structuredState.lastValidationError.length === 0),
    });
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
  registerChildToolCallHandler(pi, childState, state);
  registerChildToolResultHandler(pi, childState, state);
  registerChildTurnHandlers(pi, childState, state);
  registerChildAgentEndHandler(pi, childState, state);
  registerChildSessionShutdownHandler(pi, childState, state);
}
