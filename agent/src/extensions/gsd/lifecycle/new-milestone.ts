import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { launchGsdWorkflowSession } from "../workflow-launch.js";

function stripNewMilestoneSubcommand(rawArgs: string | undefined): string | undefined {
  if (rawArgs === undefined) {
    return undefined;
  }
  const normalizedRawArgs = rawArgs
    .trim()
    .replace(/^new-milestone(?:\s+|$)/u, "")
    .trim();
  return normalizedRawArgs.length > 0 ? normalizedRawArgs : undefined;
}

export async function handleGsdNewMilestone(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
  rawArgs?: string,
): Promise<void> {
  await launchGsdWorkflowSession(pi, ctx, {
    commandName: "new-milestone",
    commandArguments: stripNewMilestoneSubcommand(rawArgs) ?? args.milestone,
    commandResourcePath: "commands/gsd/new-milestone.md",
    workflowResourcePaths: ["workflows/new-milestone.md"],
    extraResourcePaths: [
      "references/questioning.md",
      "references/ui-brand.md",
      "templates/project.md",
      "templates/requirements.md",
      "templates/roadmap.md",
      "templates/state.md",
      "templates/research-project/ARCHITECTURE.md",
      "templates/research-project/FEATURES.md",
      "templates/research-project/PITFALLS.md",
      "templates/research-project/STACK.md",
      "templates/research-project/SUMMARY.md",
      "agents/gsd-project-researcher.md",
      "agents/gsd-roadmapper.md",
    ],
    extraInstructions: [
      "Prefer continuing phase numbering unless user explicitly requests reset.",
      "If workflow references unavailable `MILESTONES.md`, infer shipped milestone history from `.planning/milestones/`, `PROJECT.md`, and `ROADMAP.md`.",
    ],
  });
}
