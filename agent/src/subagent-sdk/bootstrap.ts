import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

import {
  activateAutoExitTimeoutMode,
  consumeParentInjectedInputMarker,
  isAutoExitTimeoutModeActive,
  readLatestChildStructuredOutputState,
} from "./persistence.js";
import { readChildState } from "./launch.js";
import {
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  serializeSubagentStructuredOutputEntry,
  type ChildBootstrapState,
  type StructuredOutputError,
} from "./types.js";

const bootstrapInstalledSymbol = Symbol.for("@shekohex/agent/subagent-sdk/bootstrap-installed");
const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";
const DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT = 3;
const STRUCTURED_OUTPUT_SYSTEM_PROMPT =
  "IMPORTANT: You MUST call the StructuredOutput tool as your final response. Do not respond with plain text for the final answer.";
const STRUCTURED_OUTPUT_FINAL_TOOL_ERROR =
  "StructuredOutput must be the only tool call in the final turn.";

type BootstrapAwareExtensionApi = ExtensionAPI & {
  [bootstrapInstalledSymbol]?: boolean;
};

type StructuredOutputState = {
  enabled: boolean;
  retryCount: number;
  attempts: number;
  captured?: unknown;
  lastValidationError?: string;
  completed: boolean;
};

function isJsonSchemaOutputFormat(
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
  if (!Number.isFinite(requested)) {
    return DEFAULT_STRUCTURED_OUTPUT_RETRY_COUNT;
  }

  return Math.max(0, Math.floor(requested));
}

function buildStructuredOutputError(
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

function persistStructuredOutputState(
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

function buildStructuredOutputRetryPrompt(state: StructuredOutputState): string {
  const retriesLeft = Math.max(0, state.retryCount - state.attempts);
  const suffix = state.lastValidationError
    ? ` Last validation error: ${state.lastValidationError}`
    : "";

  return `You must call the ${STRUCTURED_OUTPUT_TOOL_NAME} tool with output that matches the schema exactly. Do not end with plain text. Retries left: ${retriesLeft}.${suffix}`;
}

function extractToolResultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }

  const chunks = content
    .map((part) => {
      if (typeof part !== "object" || part === null) {
        return "";
      }

      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n")
    .trim();

  return chunks.length > 0 ? chunks : undefined;
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

function formatChildSessionDisplayName(name: string, prompt: string): string {
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
  pi.setActiveTools(Array.from(activeTools).sort((left, right) => left.localeCompare(right)));
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

export function installChildBootstrap(pi: ExtensionAPI): void {
  const bootstrapAwarePi = pi as BootstrapAwareExtensionApi;
  if (bootstrapAwarePi[bootstrapInstalledSymbol]) {
    return;
  }

  bootstrapAwarePi[bootstrapInstalledSymbol] = true;

  const childState = readChildState();
  const restoredStructuredState = childState
    ? readLatestChildStructuredOutputState(childState.sessionPath)
    : undefined;
  const structuredRetryCount = getStructuredRetryCount(childState);
  const autoExitEnabled = Boolean(childState?.autoExit);
  const structuredState: StructuredOutputState = {
    enabled: isJsonSchemaOutputFormat(childState),
    retryCount: structuredRetryCount,
    attempts: Math.min(restoredStructuredState?.attempts ?? 0, structuredRetryCount),
    captured: restoredStructuredState?.structured,
    lastValidationError: restoredStructuredState?.error?.lastValidationError,
    completed:
      restoredStructuredState?.status === "captured" || restoredStructuredState?.status === "error",
  };
  let turnStructuredCaptured = false;
  let turnStructuredPayload: unknown;
  let turnStructuredValidationError: string | undefined;
  let lastTurnStructuredCaptured = false;
  let lastTurnStructuredPayload: unknown;
  let lastTurnStructuredValidationError: string | undefined;
  let pendingIdleShutdown: ReturnType<typeof setTimeout> | undefined;
  let timeoutModeActive = childState ? isAutoExitTimeoutModeActive(childState.sessionId) : false;

  if (isJsonSchemaOutputFormat(childState)) {
    const structuredOutputTool = defineTool({
      name: STRUCTURED_OUTPUT_TOOL_NAME,
      description:
        "Submit the final structured JSON response. Use this tool exactly once as the final action.",
      parameters: childState.outputFormat.schema as TSchema,
      async execute(_toolCallId, params) {
        turnStructuredCaptured = true;
        turnStructuredPayload = params;
        return {
          content: [{ type: "text", text: "Structured output captured." }],
          details: { captured: true },
        };
      },
    });

    pi.registerTool(structuredOutputTool);
  }

  const cancelIdleShutdown = () => {
    if (!pendingIdleShutdown) {
      return;
    }

    clearTimeout(pendingIdleShutdown);
    pendingIdleShutdown = undefined;
  };

  const scheduleIdleShutdown = (ctx: ExtensionContext, currentChildState: ChildBootstrapState) => {
    cancelIdleShutdown();

    if (!timeoutModeActive) {
      ctx.shutdown();
      return;
    }

    pendingIdleShutdown = setTimeout(() => {
      pendingIdleShutdown = undefined;
      if (!autoExitEnabled || !isChildSession(currentChildState, ctx)) {
        return;
      }

      ctx.shutdown();
    }, currentChildState.autoExitTimeoutMs ?? 30_000);
    pendingIdleShutdown.unref?.();
  };

  pi.on("session_start", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return;
    }

    timeoutModeActive = isAutoExitTimeoutModeActive(currentChildState.sessionId);

    applyChildToolState(pi, currentChildState);
    pi.setSessionName(
      formatChildSessionDisplayName(currentChildState.name, currentChildState.prompt),
    );

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.onTerminalInput((data) => {
      if (!autoExitEnabled || !data.trim()) {
        return undefined;
      }

      if (consumeParentInjectedInputMarker(currentChildState.sessionId)) {
        return undefined;
      }

      timeoutModeActive = true;
      activateAutoExitTimeoutMode(currentChildState.sessionId);
      cancelIdleShutdown();
      return undefined;
    });
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return undefined;
    }

    cancelIdleShutdown();
    applyChildToolState(pi, currentChildState);
    turnStructuredCaptured = false;
    turnStructuredPayload = undefined;
    turnStructuredValidationError = undefined;
    lastTurnStructuredCaptured = false;
    lastTurnStructuredPayload = undefined;
    lastTurnStructuredValidationError = undefined;

    if (!isJsonSchemaOutputFormat(currentChildState) || structuredState.completed) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${STRUCTURED_OUTPUT_SYSTEM_PROMPT}`,
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx) || !isJsonSchemaOutputFormat(currentChildState)) {
      return undefined;
    }

    if (event.toolName !== STRUCTURED_OUTPUT_TOOL_NAME || !event.isError) {
      return undefined;
    }

    turnStructuredValidationError =
      extractToolResultText(event.content) ?? "Structured output tool validation failed.";
    return undefined;
  });

  pi.on("turn_start", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx) || !isJsonSchemaOutputFormat(currentChildState)) {
      return;
    }

    turnStructuredCaptured = false;
    turnStructuredPayload = undefined;
    turnStructuredValidationError = undefined;
  });

  pi.on("turn_end", async (event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx) || !isJsonSchemaOutputFormat(currentChildState)) {
      return;
    }

    const successfulStructuredCalls = event.toolResults.filter(
      (toolResult) => toolResult.toolName === STRUCTURED_OUTPUT_TOOL_NAME && !toolResult.isError,
    ).length;
    const nonStructuredCalls = event.toolResults.filter(
      (toolResult) => toolResult.toolName !== STRUCTURED_OUTPUT_TOOL_NAME,
    ).length;

    if (successfulStructuredCalls > 0) {
      const isSoleStructuredCall = successfulStructuredCalls === 1 && nonStructuredCalls === 0;
      if (isSoleStructuredCall && turnStructuredCaptured && turnStructuredPayload !== undefined) {
        lastTurnStructuredCaptured = true;
        lastTurnStructuredPayload = turnStructuredPayload;
        lastTurnStructuredValidationError = undefined;
        return;
      }

      lastTurnStructuredCaptured = false;
      lastTurnStructuredPayload = undefined;
      lastTurnStructuredValidationError =
        turnStructuredValidationError ?? STRUCTURED_OUTPUT_FINAL_TOOL_ERROR;
      return;
    }

    lastTurnStructuredCaptured = false;
    lastTurnStructuredPayload = undefined;
    lastTurnStructuredValidationError = turnStructuredValidationError;
  });

  pi.on("agent_end", async (_event, ctx) => {
    const currentChildState = childState;
    if (!isChildSession(currentChildState, ctx)) {
      return;
    }

    if (isJsonSchemaOutputFormat(currentChildState) && !structuredState.completed) {
      if (lastTurnStructuredCaptured && lastTurnStructuredPayload !== undefined) {
        structuredState.captured = lastTurnStructuredPayload;
        persistStructuredOutputState(pi, {
          status: "captured",
          attempts: structuredState.attempts,
          retryCount: structuredState.retryCount,
          structured: lastTurnStructuredPayload,
          updatedAt: Date.now(),
        });
        structuredState.completed = true;
        ctx.shutdown();
        return;
      }

      if (lastTurnStructuredValidationError) {
        structuredState.lastValidationError = lastTurnStructuredValidationError;
      }

      structuredState.attempts += 1;

      if (structuredState.attempts < structuredState.retryCount) {
        persistStructuredOutputState(pi, {
          status: "retrying",
          attempts: structuredState.attempts,
          retryCount: structuredState.retryCount,
          updatedAt: Date.now(),
        });
        setTimeout(() => {
          void pi.sendUserMessage(buildStructuredOutputRetryPrompt(structuredState), {
            deliverAs: "followUp",
          });
        }, 0);
        return;
      }

      const errorCode = structuredState.lastValidationError
        ? "validation_failed"
        : "missing_tool_call";
      const errorMessage = structuredState.lastValidationError
        ? "Structured output validation failed and retry budget was exhausted."
        : "Model did not call StructuredOutput before retry budget was exhausted.";

      const error = buildStructuredOutputError(errorCode, errorMessage, structuredState);
      persistStructuredOutputState(pi, {
        status: "error",
        attempts: structuredState.attempts,
        retryCount: structuredState.retryCount,
        error,
        updatedAt: Date.now(),
      });
      structuredState.completed = true;
      ctx.shutdown();
      return;
    }

    if (!autoExitEnabled) {
      return;
    }

    scheduleIdleShutdown(ctx, currentChildState);
  });

  pi.on("session_shutdown", async () => {
    cancelIdleShutdown();
  });
}
