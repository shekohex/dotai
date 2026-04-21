import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { installChildBootstrap, isChildSession } from "../../subagent-sdk/bootstrap.js";
import { buildLaunchCommand, readChildState } from "../../subagent-sdk/launch.js";
import { createSubagentSDK } from "../../subagent-sdk/sdk.js";
import { TmuxAdapter } from "../../subagent-sdk/tmux.js";
import { buildSubagentPromptGuidelines } from "./execution.js";
import {
  ensureParentSubagentToolActive,
  scheduleParentSubagentToolActivation,
  type CreateSubagentExtensionOptions,
  type SubagentRuntimeState,
} from "./shared.js";
import { createSubagentToolDefinition, registerSubagentRuntimeEvents } from "./tool.js";

function installEnabledSubagentExtension(
  pi: ExtensionAPI,
  resolvedOptions: CreateSubagentExtensionOptions,
): void {
  const adapter =
    resolvedOptions.adapterFactory?.(pi) ??
    new TmuxAdapter(
      (command, args, execOptions) => pi.exec(command, args, execOptions),
      process.cwd(),
    );
  const sdk = createSubagentSDK(pi, { adapter, buildLaunchCommand });
  const runtimeState: SubagentRuntimeState = {};
  const subagentTool = createSubagentToolDefinition(sdk);
  const syncSubagentToolRegistration = async (ctx: ExtensionContext): Promise<void> => {
    runtimeState.ctx = ctx;
    const promptGuidelines = await buildSubagentPromptGuidelines(ctx);
    const signature = promptGuidelines.join("\n\n");
    if (runtimeState.toolPromptSignature !== signature) {
      subagentTool.promptGuidelines = promptGuidelines;
      runtimeState.toolPromptSignature = signature;
      pi.registerTool(subagentTool);
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
