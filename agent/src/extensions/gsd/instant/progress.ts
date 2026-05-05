import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { computeProgress } from "../state/progress.js";

export function handleGsdProgress(_pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const result = computeProgress(ctx.cwd);
  const milestone = result.milestone === undefined ? "" : ` milestone=${result.milestone}`;
  ctx.ui.notify(
    `Progress ${result.bar} ${result.percent}%${milestone} phase=${result.currentPhase ?? "-"} plan=${result.currentPlan ?? "-"}`,
    "info",
  );
}
