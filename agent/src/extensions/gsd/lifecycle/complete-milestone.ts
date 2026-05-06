import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

export async function handleGsdCompleteMilestone(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "complete-milestone",
    commandArguments: args.version,
    commandResourcePath: "commands/gsd/complete-milestone.md",
    workflowResourcePaths: ["workflows/complete-milestone.md"],
    extraResourcePaths: [
      "templates/milestone-archive.md",
      "templates/milestone.md",
      "templates/retrospective.md",
    ],
    extraInstructions: [
      "Use local `.planning/milestones/` archive layout as source of truth.",
      "If local native command surface should not tag git automatically, pause for explicit user confirmation before any git tag step.",
    ],
  });
}
