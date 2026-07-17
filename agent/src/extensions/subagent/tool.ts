import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SubagentSDK } from "../../subagent-sdk/sdk.js";
import {
  SubagentToolParamsSchema,
  type ChildBootstrapState,
  type SubagentToolResultDetails,
} from "../../subagent-sdk/types.js";
import { executeSubagentToolAction, SUBAGENT_BASE_PROMPT_GUIDELINES } from "./execution.js";
import { renderSubagentToolCall, renderSubagentToolResult } from "./render-state.js";
import { normalizeSubagentExecutionError, validateToolParams } from "./shared.js";

function createSubagentToolDefinition(sdk: SubagentSDK) {
  return defineTool<typeof SubagentToolParamsSchema, SubagentToolResultDetails>({
    name: "subagent",
    label: "π",
    renderShell: "self",
    description: [
      "Manage mux-backed child pi sessions. Actions: start, message, cancel, list. No read action; inspect backend terminal only when needed. Default/text starts run in background and auto-send completion status; do not poll. `outputFormat` json_schema blocks and returns validated JSON directly. `message` auto-resumes completed persisted children. Use persisted:false for one-offs, completion:false to suppress status.",
      ...SUBAGENT_BASE_PROMPT_GUIDELINES,
      "When selecting a child mode, use an exact configured mode name.",
    ].join(" "),
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
  ensureParentSubagentToolActive: (pi: ExtensionAPI) => void,
  scheduleParentSubagentToolActivation: (pi: ExtensionAPI) => void,
  isChildSession: (state: ChildBootstrapState | undefined, ctx: ExtensionContext) => boolean,
  readChildState: () => ChildBootstrapState | undefined,
  isSubagentToolEnabled: () => boolean,
  restoreToolState: (ctx: ExtensionContext) => void,
): void {
  scheduleParentSubagentToolActivation(pi);
  pi.on("session_start", async (_event, ctx) => {
    const childSession = isChildSession(readChildState(), ctx);
    if (!childSession) restoreToolState(ctx);
    if (!childSession && isSubagentToolEnabled()) {
      ensureParentSubagentToolActive(pi);
      await sdk.restore(ctx);
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!isChildSession(readChildState(), ctx)) restoreToolState(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!isChildSession(readChildState(), ctx) && isSubagentToolEnabled()) {
      ensureParentSubagentToolActive(pi);
    }
  });
  pi.on("session_shutdown", () => {
    sdk.dispose();
  });
}

export { createSubagentToolDefinition, registerSubagentRuntimeEvents };
