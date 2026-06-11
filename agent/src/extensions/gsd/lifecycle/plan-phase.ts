import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchPlanPhaseWorkflow } from "./plan-phase-workflow.js";

export async function handleGsdPlanPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs?: string,
): Promise<void> {
  if (typeof pi.sendUserMessage !== "function" || ctx.sessionManager === undefined) {
    ctx.ui.notify(
      "Cannot run /gsd plan-phase: workflow session support unavailable in this context.",
      "warning",
    );
    return;
  }

  await launchPlanPhaseWorkflow(pi, ctx, args, rawArgs);
}
