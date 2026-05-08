import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { handleGsdNext } from "./next.js";
import { computeProgress } from "../state/progress.js";

export function handleGsdProgress(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): Promise<void> | void {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }
  if (args.next === true) {
    return handleGsdNext(pi, ctx, args);
  }
  const result = computeProgress(ctx.cwd);
  const milestone = result.milestone === undefined ? "" : ` milestone=${result.milestone}`;
  ctx.ui.notify(
    `Progress ${result.bar} ${result.percent}%${milestone} phase=${result.currentPhase ?? "-"} plan=${result.currentPlan ?? "-"}`,
    "info",
  );
}
