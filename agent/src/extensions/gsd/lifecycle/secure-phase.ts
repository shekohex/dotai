import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

function stripSecurePhaseSubcommand(rawArgs: string): string | undefined {
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^secure-phase(?:\s+|$)/u, "")
    .trim();
  return normalizedRawArgs.length > 0 ? normalizedRawArgs : undefined;
}

export async function handleGsdSecurePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs: string,
): Promise<void> {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  const commandArguments = stripSecurePhaseSubcommand(rawArgs) ?? args.phase;
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "secure-phase",
    commandArguments,
    commandResourcePath: "commands/gsd/secure-phase.md",
    workflowResourcePaths: ["workflows/secure-phase.md"],
    extraInstructions: [
      "Use workflow-launch architecture for local `/gsd secure-phase` parity.",
      "Keep security findings and accepted-risk flow inside bundled workflow resources.",
    ],
  });
}
