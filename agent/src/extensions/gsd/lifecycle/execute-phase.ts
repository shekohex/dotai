import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { orchestrateExecutePhase } from "../orchestration.js";

export async function handleGsdExecutePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  const result = await orchestrateExecutePhase(pi, ctx, args);
  ctx.ui.notify(`GSD execute-phase finished: ${result.summary}`, "info");
}
