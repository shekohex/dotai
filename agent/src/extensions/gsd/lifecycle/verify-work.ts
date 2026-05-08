import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

function stripVerifyWorkSubcommand(rawArgs: string): string | undefined {
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^verify-work(?:\s+|$)/u, "")
    .trim();
  return normalizedRawArgs.length > 0 ? normalizedRawArgs : undefined;
}

export async function handleGsdVerifyWork(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs: string,
): Promise<void> {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  const commandArguments = stripVerifyWorkSubcommand(rawArgs) ?? args.phase;
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "verify-work",
    commandArguments,
    commandResourcePath: "commands/gsd/verify-work.md",
    workflowResourcePaths: ["workflows/verify-work.md"],
    extraInstructions: [
      "Use existing local bundled runtime helpers for `init verify-work` resolution semantics, summary parsing, and persisted `.planning/phases/<phase-dir>/<phase>-UAT.md` updates.",
      "Do not call local native `orchestrateVerifyWork()` path for this command; workflow-launch wrapper is source of truth for Slice 1 verify-work foundation.",
      "Treat `.planning/phases/<phase-dir>/<phase>-UAT.md` as single source of truth for verify progress, resume after `/clear`, and later gap-closure planning.",
    ],
  });
}
