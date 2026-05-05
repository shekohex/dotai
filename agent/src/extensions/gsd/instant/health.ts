import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { computeHealth } from "../state/health.js";

export function handleGsdHealth(_pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const result = computeHealth(ctx.cwd);
  const summary =
    result.issues.length === 0
      ? "healthy"
      : result.issues.map((issue) => `${issue.severity}:${issue.file}`).join(", ");
  ctx.ui.notify(
    `Health ${result.healthy ? "ok" : "bad"} ${summary}`,
    result.healthy ? "info" : "warning",
  );
}
