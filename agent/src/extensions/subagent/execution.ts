import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { buildAvailableModesPromptGuideline } from "../available-modes.js";
import type { SubagentSDK } from "../../subagent-sdk/sdk.js";
import type {
  RuntimeSubagent,
  SubagentToolParams,
  SubagentToolResultDetails,
} from "../../subagent-sdk/types.js";
import {
  formatAutoResumedMessageResultText,
  formatCancelResultText,
  formatListResultText,
  formatMessageResultText,
  formatStartResultText,
  formatStructuredStartResultText,
  isRuntimeSubagent,
  isTypeboxSchema,
  serializeStructuredStartContent,
  type SubagentStartValue,
} from "./shared.js";

const SUBAGENT_BASE_PROMPT_GUIDELINES = [
  "Use `subagent` when the user wants parallel or delegated work in another tmux-backed pi session.",
  "Use `start` to launch a child session, `message` for follow-up or to auto-resume a dead child session before delivery, `cancel` to stop it, and `list` to inspect child status.",
  "There is no subagent read tool. To inspect a child session, look at its tmux pane/window output directly from the parent session.",
  "Do not poll with `list` just to get the final result. By default, wait for the automatic completion summary and only use `message` or `cancel` when you need to steer or stop the child.",
] as const;

const SUBAGENT_AVAILABLE_MODES_HEADING =
  "Available subagent modes. When the user asks for a mode, use one of these exact names:";

async function buildSubagentPromptGuidelines(ctx: ExtensionContext): Promise<string[]> {
  return [
    ...SUBAGENT_BASE_PROMPT_GUIDELINES,
    await buildAvailableModesPromptGuideline(ctx.cwd, SUBAGENT_AVAILABLE_MODES_HEADING),
  ];
}

function executeSubagentToolAction(
  sdk: SubagentSDK,
  params: SubagentToolParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolResultDetails>> {
  if (params.action === "start") {
    return executeSubagentStartAction(sdk, params, signal, onUpdate, ctx);
  }
  if (params.action === "message") {
    return executeSubagentMessageAction(sdk, params, onUpdate, ctx);
  }
  if (params.action === "cancel") {
    return executeSubagentCancelAction(sdk, params);
  }
  return Promise.resolve(executeSubagentListAction(sdk, params));
}

async function executeSubagentStartAction(
  sdk: SubagentSDK,
  params: SubagentToolParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolResultDetails>> {
  const started = await spawnSubagentStartResult(sdk, params, signal, onUpdate, ctx);
  if (!started.ok) {
    throw new Error(started.error.message);
  }

  return buildSubagentStartResult(params, started.value as SubagentStartValue);
}

function spawnSubagentStartResult(
  sdk: SubagentSDK,
  params: SubagentToolParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
) {
  const startBaseParams = {
    name: params.name!,
    task: params.task!,
    mode: params.mode,
    handoff: params.handoff,
    cwd: params.cwd,
    autoExit: params.autoExit,
  };
  if (params.outputFormat?.type === "json_schema") {
    return sdk.spawn(
      {
        ...startBaseParams,
        outputFormat: {
          type: "json_schema",
          schema: isTypeboxSchema(params.outputFormat.schema)
            ? params.outputFormat.schema
            : (() => {
                throw new Error("Invalid outputFormat.schema");
              })(),
          retryCount: params.outputFormat.retryCount,
        },
      },
      ctx,
      onUpdate,
      signal,
    );
  }
  return sdk.spawn(
    {
      ...startBaseParams,
      outputFormat: params.outputFormat?.type === "text" ? { type: "text" } : undefined,
    },
    ctx,
    onUpdate,
    signal,
  );
}

function buildSubagentStartResult(
  params: SubagentToolParams,
  startedValue: SubagentStartValue,
): AgentToolResult<SubagentToolResultDetails> {
  const startedState: RuntimeSubagent =
    "state" in startedValue && isRuntimeSubagent(startedValue.state)
      ? startedValue.state
      : startedValue.handle.getState();
  const structuredContent =
    "structured" in startedValue
      ? serializeStructuredStartContent(startedValue.structured)
      : undefined;

  return {
    content: [
      {
        type: "text",
        text:
          structuredContent ??
          ("structured" in startedValue
            ? formatStructuredStartResultText(startedState)
            : formatStartResultText(startedState)),
      },
    ],
    details: {
      action: "start",
      args: params,
      prompt: startedValue.prompt,
      state: startedState,
      structured: "structured" in startedValue ? startedValue.structured : undefined,
    } satisfies SubagentToolResultDetails,
  };
}

async function executeSubagentMessageAction(
  sdk: SubagentSDK,
  params: SubagentToolParams,
  onUpdate: AgentToolUpdateCallback | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<SubagentToolResultDetails>> {
  const { result } = await sdk.message(
    {
      sessionId: params.sessionId!,
      message: params.message!,
      delivery: params.delivery ?? "steer",
    },
    ctx,
    onUpdate,
  );

  return {
    content: [
      {
        type: "text",
        text: result.autoResumed
          ? formatAutoResumedMessageResultText(result.state, params.delivery ?? "steer")
          : formatMessageResultText(result.state, params.delivery ?? "steer"),
      },
    ],
    details: {
      action: "message",
      args: params,
      message: params.message!,
      delivery: params.delivery ?? "steer",
      state: result.state,
      autoResumed: result.autoResumed,
      resumePrompt: result.resumePrompt,
    } satisfies SubagentToolResultDetails,
  };
}

async function executeSubagentCancelAction(
  sdk: SubagentSDK,
  params: SubagentToolParams,
): Promise<AgentToolResult<SubagentToolResultDetails>> {
  const result = await sdk.cancel({ sessionId: params.sessionId! });
  return {
    content: [{ type: "text", text: formatCancelResultText(result) }],
    details: { action: "cancel", args: params, state: result } satisfies SubagentToolResultDetails,
  };
}

function executeSubagentListAction(
  sdk: SubagentSDK,
  params: SubagentToolParams,
): AgentToolResult<SubagentToolResultDetails> {
  const subagents = sdk.list();
  return {
    content: [{ type: "text", text: formatListResultText(subagents) }],
    details: { action: "list", args: params, subagents } satisfies SubagentToolResultDetails,
  };
}

export {
  buildSubagentPromptGuidelines,
  executeSubagentToolAction,
  SUBAGENT_AVAILABLE_MODES_HEADING,
  SUBAGENT_BASE_PROMPT_GUIDELINES,
};
