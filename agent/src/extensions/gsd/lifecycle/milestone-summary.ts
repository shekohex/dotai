import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

export async function handleGsdMilestoneSummary(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "milestone-summary",
    commandArguments: args.version,
    commandResourcePath: "commands/gsd/milestone-summary.md",
    workflowResourcePaths: ["workflows/milestone-summary.md"],
    extraResourcePaths: [],
    extraInstructions: [
      "Scope artifact reads and git stats to requested milestone only instead of concatenating every phase artifact or commit in repo.",
      "For archived milestones, read phase artifacts from `.planning/milestones/vX.Y-phases/` when `complete-milestone` moved them there.",
      "Do not leave `STATE.md` dirty after report generation unless final user-visible output explicitly includes coordinated state mutation.",
    ],
  });
}
