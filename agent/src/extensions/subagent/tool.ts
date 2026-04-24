import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../session-replacement.js";
import type { SubagentSDK } from "../../subagent-sdk/sdk.js";
import {
  SubagentToolParamsSchema,
  type ChildBootstrapState,
  type SubagentToolResultDetails,
} from "../../subagent-sdk/types.js";
import {
  executeSubagentToolAction,
  SUBAGENT_AVAILABLE_MODES_HEADING,
  SUBAGENT_BASE_PROMPT_GUIDELINES,
} from "./execution.js";
import { renderSubagentToolCall, renderSubagentToolResult } from "./render-state.js";
import { normalizeSubagentExecutionError, validateToolParams } from "./shared.js";

function createSubagentToolDefinition(sdk: SubagentSDK) {
  return defineTool<typeof SubagentToolParamsSchema, SubagentToolResultDetails>({
    name: "subagent",
    label: "π",
    renderShell: "self",
    description:
      "Manage tmux-backed child pi sessions. Actions: start, message, cancel, list. Session ids are UUID v4. `message` auto-resumes a dead child session before delivery when needed. There is no subagent read action; inspect the child tmux pane/window output directly from the parent session. For final results, usually wait for the automatic completion summary instead of polling.",
    promptSnippet:
      "use `subagent` to start, message, cancel, or list tmux-backed child pi sessions; session ids are UUID v4; `message` auto-resumes a dead child session before delivery when needed; there is no subagent read action, and the default flow is to wait for the automatic completion summary",
    promptGuidelines: [...SUBAGENT_BASE_PROMPT_GUIDELINES, SUBAGENT_AVAILABLE_MODES_HEADING],
    parameters: SubagentToolParamsSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        validateToolParams(params);
        return await executeSubagentToolAction(sdk, params, signal, onUpdate, ctx);
      } catch (error) {
        throw normalizeSubagentExecutionError(params.action, error);
      }
    },
    renderCall: renderSubagentToolCall,
    renderResult: renderSubagentToolResult,
  });
}

function registerSubagentRuntimeEvents(
  pi: ExtensionAPI,
  sdk: SubagentSDK,
  runtimeState: { ctx?: Parameters<typeof sdk.restore>[0]; toolPromptSignature?: string },
  syncSubagentToolRegistration: (ctx: Parameters<typeof sdk.restore>[0]) => Promise<void>,
  ensureParentSubagentToolActive: (pi: ExtensionAPI) => void,
  scheduleParentSubagentToolActivation: (pi: ExtensionAPI) => void,
  isChildSession: (state: ChildBootstrapState | undefined, ctx: ExtensionContext) => boolean,
  readChildState: () => ChildBootstrapState | undefined,
): void {
  const modesChangedEvents = (
    pi as {
      events?: {
        on?: (eventName: string, handler: (...args: unknown[]) => void | Promise<void>) => unknown;
      };
    }
  ).events;
  modesChangedEvents?.on?.("modes:changed", async () => {
    if (runtimeState.ctx) {
      try {
        await syncSubagentToolRegistration(runtimeState.ctx);
      } catch (error) {
        if (isStaleSessionReplacementContextError(error)) {
          runtimeState.ctx = undefined;
          return;
        }
        throw error;
      }
    }
  });

  scheduleParentSubagentToolActivation(pi);
  pi.on("session_start", async (_event, ctx) => {
    await syncSubagentToolRegistration(ctx);
    if (!isChildSession(readChildState(), ctx)) {
      ensureParentSubagentToolActive(pi);
      await sdk.restore(ctx);
    }
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await syncSubagentToolRegistration(ctx);
    if (!isChildSession(readChildState(), ctx)) {
      ensureParentSubagentToolActive(pi);
    }
  });
  pi.on("session_shutdown", () => {
    runtimeState.ctx = undefined;
    sdk.dispose();
  });
}

export { createSubagentToolDefinition, registerSubagentRuntimeEvents };
