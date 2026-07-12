import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStaleSessionReplacementContextError } from "../session-replacement.js";
import { installChildBootstrap, isChildSession } from "../../subagent-sdk/bootstrap.js";
import { createDefaultMuxAdapter } from "../../subagent-sdk/default-mux.js";
import { buildLaunchCommand, readChildState } from "../../subagent-sdk/launch.js";
import { createSubagentSDK } from "../../subagent-sdk/sdk.js";
import { createDefaultSubagentRuntimeHooks } from "../../subagent-sdk/runtime-hooks.js";
import {
  createToolStateEntry,
  readToolState,
  TOOL_STATE_ENTRY_TYPE,
} from "../../utils/tool-state.js";
import { buildSubagentPromptGuidelines } from "./execution.js";
import {
  ensureParentSubagentToolActive,
  scheduleParentSubagentToolActivation,
  type CreateSubagentExtensionOptions,
  type SubagentRuntimeState,
} from "./shared.js";
import { createSubagentToolDefinition, registerSubagentRuntimeEvents } from "./tool.js";
import { isSubagentToolEnabled, setSubagentToolEnabled, SUBAGENT_TOOL_NAME } from "./state.js";
import { getSubagentsSettings } from "./settings.js";

function installEnabledSubagentExtension(
  pi: ExtensionAPI,
  resolvedOptions: CreateSubagentExtensionOptions,
): void {
  const adapter = resolvedOptions.adapterFactory?.(pi) ?? createDefaultMuxAdapter(pi);
  const setEnabled = (enabled: boolean, options?: { persist?: boolean }): void => {
    setSubagentToolEnabled(enabled);
    const activeTools = new Set(pi.getActiveTools());
    if (enabled) activeTools.add(SUBAGENT_TOOL_NAME);
    else activeTools.delete(SUBAGENT_TOOL_NAME);
    pi.setActiveTools(Array.from(activeTools).toSorted((left, right) => left.localeCompare(right)));
    if (options?.persist === true) {
      pi.appendEntry(TOOL_STATE_ENTRY_TYPE, createToolStateEntry(SUBAGENT_TOOL_NAME, enabled));
    }
  };
  const restoreToolState = (ctx: ExtensionContext): void => {
    setEnabled(
      readToolState(ctx.sessionManager.getBranch(), SUBAGENT_TOOL_NAME) ??
        getSubagentsSettings().enabled,
    );
  };
  const hooks = createDefaultSubagentRuntimeHooks(pi, {
    toolControl: {
      getDefaultEnabled() {
        return getSubagentsSettings().enabled;
      },
      isEnabled: isSubagentToolEnabled,
      setEnabled(enabled) {
        setEnabled(enabled, { persist: true });
      },
    },
  });
  const sdk = createSubagentSDK(pi, { adapter, buildLaunchCommand, hooks });
  const runtimeState: SubagentRuntimeState = {};
  const subagentTool = createSubagentToolDefinition(sdk);
  const syncSubagentToolRegistration = async (ctx: ExtensionContext): Promise<void> => {
    runtimeState.ctx = ctx;
    try {
      const promptGuidelines = await buildSubagentPromptGuidelines(ctx);
      const signature = promptGuidelines.join("\n\n");
      if (runtimeState.toolPromptSignature !== signature) {
        subagentTool.promptGuidelines = promptGuidelines;
        runtimeState.toolPromptSignature = signature;
        pi.registerTool(subagentTool);
      }
    } catch (error) {
      if (isStaleSessionReplacementContextError(error)) {
        if (runtimeState.ctx === ctx) {
          runtimeState.ctx = undefined;
        }
        return;
      }
      throw error;
    }
  };

  pi.registerTool(subagentTool);
  registerSubagentRuntimeEvents(
    pi,
    sdk,
    runtimeState,
    syncSubagentToolRegistration,
    ensureParentSubagentToolActive,
    scheduleParentSubagentToolActivation,
    isChildSession,
    readChildState,
    isSubagentToolEnabled,
    restoreToolState,
  );
}

function createSubagentExtension(options?: CreateSubagentExtensionOptions) {
  const resolvedOptions: CreateSubagentExtensionOptions = options ?? { enabled: true };

  return function subagentExtension(pi: ExtensionAPI): void {
    installChildBootstrap(pi);

    if (resolvedOptions.enabled === false) {
      return;
    }
    installEnabledSubagentExtension(pi, resolvedOptions);
  };
}

export { createSubagentExtension };
