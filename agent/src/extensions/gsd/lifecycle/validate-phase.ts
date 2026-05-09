import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { resolveValidatePhaseSelection } from "../state/validate-phase.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

function stripValidatePhaseSubcommand(rawArgs: string): string | undefined {
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^validate-phase(?:\s+|$)/u, "")
    .trim();
  return normalizedRawArgs.length > 0 ? normalizedRawArgs : undefined;
}

export async function handleGsdValidatePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs: string,
): Promise<void> {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  const resolved = resolveValidatePhaseSelection(ctx.cwd, args.phase);
  if (resolved.error !== undefined || resolved.selection === undefined) {
    ctx.ui.notify(resolved.error ?? "Cannot run /gsd validate-phase.", "warning");
    return;
  }

  const commandArguments = stripValidatePhaseSubcommand(rawArgs) ?? resolved.selection.phase.number;
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "validate-phase",
    commandArguments,
    commandResourcePath: "commands/gsd/validate-phase.md",
    workflowResourcePaths: ["workflows/validate-phase.md"],
    extraResourcePaths: ["templates/VALIDATION.md", "references/gates.md"],
    extraInstructions: [
      "Use workflow-launch architecture for local `/gsd validate-phase` parity.",
      `Default omitted-phase target already resolved locally to phase ${resolved.selection.phase.number} using helper-ready roadmap-matching SUMMARY evidence.`,
      "Fail closed if bundled workflow discovers missing validation prerequisites or non-executed phase state.",
    ],
  });
}
