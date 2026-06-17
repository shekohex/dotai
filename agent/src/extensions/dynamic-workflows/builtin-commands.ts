/** Built-in workflow slash commands. Commands inject an agent turn that prepares workflow args. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  buildBuiltinWorkflowInvocationPrompt,
  listRunnableBuiltinWorkflows,
  type BuiltinWorkflowDefinition,
} from "./builtin-registry.js";

function alreadyRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

export function registerBuiltinWorkflows(
  pi: ExtensionAPI,
  opts: { enableWorkflowTool: () => void },
): BuiltinWorkflowDefinition[] {
  const workflows = listRunnableBuiltinWorkflows();

  for (const workflow of workflows) registerAgentDrivenWorkflow(pi, opts, workflow);
  return workflows;
}

function registerAgentDrivenWorkflow(
  pi: ExtensionAPI,
  opts: { enableWorkflowTool: () => void },
  workflow: BuiltinWorkflowDefinition,
): void {
  if (alreadyRegistered(pi, workflow.commandName)) return;
  pi.registerCommand(workflow.commandName, {
    description: workflow.description,
    getArgumentCompletions(argumentPrefix) {
      return [
        {
          value: argumentPrefix,
          label: "[context]",
          description: "Context used by agent to prepare workflow args",
        },
      ];
    },
    handler(args: string, ctx: ExtensionCommandContext) {
      opts.enableWorkflowTool();
      ctx.ui.notify(`Preparing /${workflow.commandName} with agent context`, "info");
      pi.sendUserMessage(buildBuiltinWorkflowInvocationPrompt(workflow, args), {
        deliverAs: "followUp",
      });
      return Promise.resolve();
    },
  });
}
