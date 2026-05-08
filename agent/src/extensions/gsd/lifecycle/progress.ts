import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { handleGsdNext } from "../instant/next.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

export async function handleGsdProgress(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): Promise<void> {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  if (args.next === true) {
    await handleGsdNext(pi, ctx, args);
    return;
  }

  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "progress",
    commandResourcePath: "commands/gsd/progress.md",
    workflowResourcePaths: ["workflows/progress.md"],
    extraInstructions: [
      "Use existing local bundled runtime helpers and query surface for progress inspection, milestone/phase resolution, and suggestions before making claims.",
      "Default local `/gsd progress` now routes through workflow-launch foundation instead of one-line TypeScript notify output.",
      "Preserve explicit unsupported handling for `--do` and `--forensic` unless those modes are genuinely implemented later.",
    ],
  });
}
