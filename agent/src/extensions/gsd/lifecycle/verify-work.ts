import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { orchestrateVerifyWork } from "../orchestration.js";

export async function handleGsdVerifyWork(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  const result = await orchestrateVerifyWork(pi, ctx, args);
  ctx.ui.notify(`GSD verify-work finished: ${result.summary}`, "info");
}
