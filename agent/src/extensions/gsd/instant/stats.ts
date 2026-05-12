import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { computeStructuredStats } from "../state/stats.js";

export function handleGsdStats(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): void {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }
  const result = computeStructuredStats(ctx.cwd);
  if (args.outputMode === "json") {
    ctx.ui.notify(JSON.stringify(result), "info");
    return;
  }
  if (args.outputMode === "table") {
    ctx.ui.notify(renderStatsTable(result), "info");
    return;
  }
  ctx.ui.notify(renderStatsTable(result), "info");
}

function renderStatsTable(result: ReturnType<typeof computeStructuredStats>): string {
  const filled = Math.round((result.percent / 100) * 10);
  const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  const lines = [
    `# ${result.milestone_version} ${result.milestone_name} — Statistics`,
    "",
    `Progress: [${bar}] ${result.phases_completed}/${result.phases_total} phases (${result.percent}%)`,
    ...(result.mvp_phases > 0
      ? [
          `Phases: ${result.phases_total} total | ${result.mvp_phases} MVP | ${result.standard_phases} standard`,
        ]
      : []),
    `Plans: ${result.total_summaries}/${result.total_plans} complete (${result.plan_percent}%)`,
    `Requirements: ${result.requirements_complete}/${result.requirements_total} complete`,
    `Git commits: ${result.git_commits ?? "unknown"}`,
    `First commit: ${result.git_first_commit_date ?? "unknown"}`,
    `Last activity: ${result.last_activity ?? "unknown"}`,
    `Project age: ${result.project_age_days === null ? "unknown" : `${String(result.project_age_days)} days`}`,
    "",
    "| Phase | Name | Plans | Completed | Status |",
    "| --- | --- | --- | --- | --- |",
    ...result.phases.map(
      (phase) =>
        `| ${phase.number} | ${phase.name} | ${phase.plans} | ${phase.summaries} | ${phase.status} |`,
    ),
  ];
  return lines.join("\n");
}
