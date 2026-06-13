import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import type { DiscussRoute } from "../state/discuss.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

function stripDiscussPhaseSubcommand(rawArgs: string | undefined): string | undefined {
  if (rawArgs === undefined) {
    return undefined;
  }
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^discuss-phase(?:\s+|$)/u, "")
    .trim();
  return normalizedRawArgs.length > 0 ? normalizedRawArgs : undefined;
}

export async function launchDiscussPhaseWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  route: DiscussRoute,
  rawArgs?: string,
): Promise<void> {
  let workflowResourcePaths = ["workflows/discuss-phase.md"];
  if (args.assumptions === true) {
    workflowResourcePaths = ["workflows/list-phase-assumptions.md"];
  } else if (route === "assumptions-artifact") {
    workflowResourcePaths = ["workflows/discuss-phase-assumptions.md"];
  }
  const extraResourcePaths =
    args.assumptions === true || route === "assumptions-artifact"
      ? ["agents/gsd-assumptions-analyzer.md", "workflows/discuss-phase/templates/context.md"]
      : [
          "workflows/discuss-phase/modes/default.md",
          "workflows/discuss-phase/modes/text.md",
          "workflows/discuss-phase/modes/batch.md",
          "workflows/discuss-phase/modes/analyze.md",
          "workflows/discuss-phase/modes/auto.md",
          "workflows/discuss-phase/modes/all.md",
          "workflows/discuss-phase/modes/chain.md",
          "workflows/discuss-phase/modes/advisor.md",
          "workflows/discuss-phase/modes/power.md",
          "workflows/discuss-phase/templates/context.md",
          "workflows/discuss-phase/templates/discussion-log.md",
          "workflows/discuss-phase/templates/checkpoint.json",
          "workflows/discuss-phase-power.md",
        ];

  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "discuss-phase",
    commandArguments: stripDiscussPhaseSubcommand(rawArgs) ?? args.phase,
    sessionStrategy: "current",
    commandResourcePath: "commands/gsd/discuss-phase.md",
    workflowResourcePaths,
    extraResourcePaths,
    extraInstructions: [
      "Use `ask_user_question` for interactive decisions unless `--text` is active; do not use hardcoded gray-area prompts.",
      "Ask phase-specific adaptive questions grounded in ROADMAP, PROJECT, REQUIREMENTS, prior CONTEXT, and local code. Avoid generic wizard questions.",
      "Write canonical phase CONTEXT.md, DISCUSSION-LOG.md, and checkpoint artifacts exactly as workflow docs specify.",
    ],
  });
}
