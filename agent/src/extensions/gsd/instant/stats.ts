import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { computeStats } from "../state/stats.js";

export function handleGsdStats(_pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const result = computeStats(ctx.cwd);
  ctx.ui.notify(
    `Stats phases=${result.phaseCount} plans=${result.planCount} summaries=${result.summaryCount} verifications=${result.verificationCount} blockers=${result.openBlockers} decisions=${result.decisionsCount}`,
    "info",
  );
}
