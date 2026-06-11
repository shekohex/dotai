import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

function stripPlanPhaseSubcommand(rawArgs: string | undefined): string | undefined {
  if (rawArgs === undefined) {
    return undefined;
  }
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^plan-phase(?:\s+|$)/u, "")
    .trim();
  return normalizedRawArgs.length > 0 ? normalizedRawArgs : undefined;
}

export async function launchPlanPhaseWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs?: string,
): Promise<void> {
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "plan-phase",
    commandArguments: stripPlanPhaseSubcommand(rawArgs) ?? args.researchPhase ?? args.phase,
    sessionStrategy: "current",
    commandResourcePath: "commands/gsd/plan-phase.md",
    workflowResourcePaths: ["workflows/plan-phase.md"],
    extraResourcePaths: [
      "agents/gsd-planner.md",
      "agents/gsd-plan-checker.md",
      "agents/gsd-phase-researcher.md",
      "agents/gsd-pattern-mapper.md",
      "references/questioning.md",
      "templates/research.md",
    ],
    extraInstructions: [
      "Preserve workflow gates, research decisions, planning, plan-checker verification loops, and routing from upstream workflow docs.",
      "Use `interview`/AskUserQuestion for interactive decisions unless `--text` is active.",
      "Do not create, rename, or switch git branches during plan-phase.",
    ],
  });
}
