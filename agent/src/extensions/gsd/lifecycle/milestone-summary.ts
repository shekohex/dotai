import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
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
      "Scope artifact reads to the requested milestone when possible instead of concatenating every phase artifact in the repo.",
      "Write final report under `.planning/reports/` and update `STATE.md` if workflow confirms it.",
    ],
  });
}
