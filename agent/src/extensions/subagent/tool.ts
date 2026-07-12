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
      "Manage mux-backed child pi sessions. Actions: start, message, cancel, list. No read action; inspect backend terminal only when needed. Default/text starts run in background and auto-send completion status; do not poll. `outputFormat` json_schema blocks and returns validated JSON directly. `message` auto-resumes completed persisted children. Use persisted:false for one-offs, completion:false to suppress status.",
    promptSnippet:
      "use `subagent` for delegated work; start/message/cancel/list; no read action; default/text=background+completion status; json_schema=blocking validated JSON; completion:false suppresses status; persisted:false one-offs",
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
  isSubagentToolEnabled: () => boolean,
  restoreToolState: (ctx: ExtensionContext) => void,
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
    const childSession = isChildSession(readChildState(), ctx);
    if (!childSession) restoreToolState(ctx);
    await syncSubagentToolRegistration(ctx);
    if (!childSession && isSubagentToolEnabled()) {
      ensureParentSubagentToolActive(pi);
      await sdk.restore(ctx);
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!isChildSession(readChildState(), ctx)) restoreToolState(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    await syncSubagentToolRegistration(ctx);
    if (!isChildSession(readChildState(), ctx) && isSubagentToolEnabled()) {
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
