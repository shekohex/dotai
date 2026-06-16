import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
  "Use `subagent` for delegated work. Actions: `start`, `message`, `cancel`, `list`; no read action; don't poll with `list` for final output.",
  "Result modes: default/text starts background and auto-sends completion status; `outputFormat: { type: 'json_schema', schema }` blocks and returns validated JSON directly; `completion:false` suppresses status.",
  "Use `message` to steer running children or auto-resume completed persisted children. Use `persisted:false` for one-offs; ephemeral children cannot resume after exit.",
  "Use `handoff:true` when the child needs parent-session context; it summarizes the current conversation into the initial prompt and appends the parent session path for focused `session_query` lookups. It is not raw inherited context, so still provide the exact objective and expected output.",
  "Without `handoff:true`, the child only knows the `task`, selected mode/tools, and cwd. Brief it like a smart colleague joining cold: objective, why it matters, known facts, relevant files/lines, constraints, and output shape.",
  "Use subagents for independent work or context isolation: broad searches, second opinions, verification, reviews, and parallelizable tasks. Avoid subagents for simple linear work that is faster in the main session.",
  "Prefer cheap specialized subagents before expensive ones: use `search` first for codebase exploration, `rush` for parallel disposable implementation probes, and `cheap-review`/`fast-review` for first-pass review sweeps. Escalate to `deep` or full `review` only when cheap passes conflict, find nothing but risk remains, or the user explicitly asks.",
  "Do not delegate understanding. If asking for implementation or fixes, pass your synthesis: specific files, conclusions, and requested change. Avoid prompts like 'based on your findings, fix it'.",
  "If a delegated child is still running, do not invent its findings; wait for completion or steer it with `message`.",
  "Avoid duplicating the same work locally after delegating unless you are explicitly verifying, comparing, or steering.",
] as const;

const SUBAGENT_AVAILABLE_MODES_HEADING =
  "Available subagent modes. When the user asks for a mode, use one of these exact names:";

async function buildSubagentPromptGuidelines(_ctx: ExtensionContext): Promise<string[]> {
  return [
    ...SUBAGENT_BASE_PROMPT_GUIDELINES,
    await buildAvailableModesPromptGuideline(SUBAGENT_AVAILABLE_MODES_HEADING),
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
    persisted: params.persisted,
    completion: params.completion,
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
