import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
      "Manage mux-backed child pi sessions. Actions: start, message, cancel, list. Session ids are UUID v4. `message` auto-resumes a dead child session before delivery when needed. There is no subagent read action; inspect backend terminal output when available. For final results, usually wait for the automatic completion summary instead of polling. Use `persisted: false` for ephemeral tasks, `outputFormat` for structured results.",
    promptSnippet:
      "use `subagent` for parallel/delegated pi sessions; actions: start, message, cancel, list; no subagent read action; wait for automatic completion summary; persisted:false for one-offs; outputFormat json_schema for structured results",
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
  const modesChangedEvents = pi.events;
  const handleModesChanged = (): unknown => {
    return (async () => {
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
    })();
  };
  const maybeUnsubscribeModesChanged = modesChangedEvents?.on?.(
    "modes:changed",
    handleModesChanged,
  );
  const unsubscribeModesChanged =
    typeof maybeUnsubscribeModesChanged === "function" ? maybeUnsubscribeModesChanged : undefined;

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
    unsubscribeModesChanged?.();
    sdk.dispose();
  });
}

export { createSubagentToolDefinition, registerSubagentRuntimeEvents };
