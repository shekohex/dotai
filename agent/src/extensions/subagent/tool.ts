import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SubagentSDK } from "../../subagent-sdk/sdk.js";
import type { LiveSessionCoordinator } from "../../live-session/coordinator.js";
import {
  SubagentToolParamsSchema,
  type ChildBootstrapState,
  type SubagentToolResultDetails,
} from "../../subagent-sdk/types.js";
import { executeSubagentToolAction, SUBAGENT_BASE_PROMPT_GUIDELINES } from "./execution.js";
import { renderSubagentToolCall, renderSubagentToolResult } from "./render-state.js";
import { normalizeSubagentExecutionError, validateToolParams } from "./shared.js";

function createSubagentToolDefinition(sdk: SubagentSDK, coordinator: LiveSessionCoordinator) {
  return defineTool<typeof SubagentToolParamsSchema, SubagentToolResultDetails>({
    name: "subagent",
    label: "π",
    renderShell: "self",
    description: [
      "Manage coordinated child Pi threads. Actions: start, list, inspect, message, interrupt, cancel. `message` uses steer to reach a running child immediately by default; `followUp` queues explicitly. `list` and `inspect` support proactive, bounded status checks for user updates and orchestration; avoid tight-loop polling because completion still arrives automatically. Children can message the parent in real time for blockers, decisions, progress, and results. `outputFormat` json_schema blocks and returns validated JSON directly. Use persisted:false for one-offs, completion:false to suppress status.",
      ...SUBAGENT_BASE_PROMPT_GUIDELINES,
      "When selecting a child mode, use an exact configured mode name.",
    ].join(" "),
    parameters: SubagentToolParamsSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        validateToolParams(params);
        return await executeSubagentToolAction(sdk, coordinator, params, signal, onUpdate, ctx);
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
  coordinator: LiveSessionCoordinator,
): void {
  scheduleParentSubagentToolActivation(pi);
  pi.on("session_start", async (_event, ctx) => {
    const childSession = isChildSession(readChildState(), ctx);
    if (!childSession) {
      restoreToolState(ctx);
      coordinator.setRootSession({
        sessionId: ctx.sessionManager.getSessionId(),
        name: "Pi",
        cwd: ctx.cwd,
        updatedAt: Date.now(),
      });
    }
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
      coordinator.setRootStatus("running");
    }
  });
  pi.on("agent_end", () => {
    coordinator.setRootStatus("idle");
  });
  pi.on("session_shutdown", () => {
    coordinator.dispose();
    sdk.dispose();
  });
}

export { createSubagentToolDefinition, registerSubagentRuntimeEvents };
