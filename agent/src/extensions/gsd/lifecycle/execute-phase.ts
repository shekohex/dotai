import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

function stripExecutePhaseSubcommand(rawArgs: string): string | undefined {
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^execute-phase(?:\s+|$)/u, "")
    .trim();
  return normalizedRawArgs.length > 0 ? normalizedRawArgs : undefined;
}

export async function handleGsdExecutePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs: string,
): Promise<void> {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  if (args.phase === undefined || args.phase.length === 0) {
    ctx.ui.notify("/gsd execute-phase requires explicit phase in Slice 1 foundation.", "warning");
    return;
  }

  const commandArguments = stripExecutePhaseSubcommand(rawArgs) ?? args.phase;
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "execute-phase",
    commandArguments,
    commandResourcePath: "commands/gsd/execute-phase.md",
    workflowResourcePaths: ["workflows/execute-phase.md"],
    extraResourcePaths: [
      "workflows/execute-phase/steps/per-plan-worktree-gate.md",
      "workflows/execute-phase/steps/post-merge-gate.md",
      "workflows/execute-phase/steps/codebase-drift-gate.md",
      "workflows/execute-plan.md",
      "references/agent-contracts.md",
      "references/context-budget.md",
      "references/worktree-path-safety.md",
      "references/checkpoints.md",
      "references/gates.md",
      "references/tdd.md",
      "references/executor-examples.md",
    ],
    extraInstructions: [
      "Use existing local bundled runtime helpers for init context, plan indexing, execute-plan flow, roadmap/state writes, and verification.",
      "Do not call local native `orchestrateExecutePhase()` path for this command; workflow-launch wrapper is source of truth for Slice 2 supported execute path.",
      "Preserve active-flag semantics exactly: `--wave` filter activates for both `--wave <N>` and `--wave=<N>` raw-arg forms; all other supported execute-phase flags activate only when their literal tokens appear in routed raw args.",
    ],
  });
}
