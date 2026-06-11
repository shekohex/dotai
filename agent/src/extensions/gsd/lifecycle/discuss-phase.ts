import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { readDiscussConfig, resolveDiscussRoute } from "../state/discuss.js";
import { launchDiscussPhaseWorkflow } from "./discuss-phase-workflow.js";

export async function handleGsdDiscussPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs?: string,
): Promise<void> {
  if (typeof pi.sendUserMessage !== "function" || ctx.sessionManager === undefined) {
    ctx.ui.notify(
      "Cannot run /gsd discuss-phase: workflow session support unavailable in this context.",
      "warning",
    );
    return;
  }

  const config = readDiscussConfig(ctx.cwd);
  const route = resolveDiscussRoute(config, args);
  await launchDiscussPhaseWorkflow(pi, ctx, args, route, rawArgs);
}
