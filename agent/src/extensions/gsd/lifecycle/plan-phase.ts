import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { orchestratePlanPhase } from "../orchestration.js";

export async function handleGsdPlanPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  const result = await orchestratePlanPhase(pi, ctx, args);
  ctx.ui.notify(`Planned ${result.planOutput.plans.length} plan(s); check approved`, "info");
}
