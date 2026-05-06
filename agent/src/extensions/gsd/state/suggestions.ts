import { computeHealth } from "./health.js";
import { computeProgress } from "./progress.js";
import { listDebugSessions } from "./debug.js";
import { listArchivedMilestones, resolveCurrentMilestone } from "./milestones.js";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases } from "./roadmap.js";
import { resolveCurrentPhase, resolveNextPlan } from "./runtime.js";
import { computeStats } from "./stats.js";

export type GsdPhaseSuggestion = {
  value: string;
  label: string;
  description: string;
};

export type GsdSimpleSuggestion = {
  value: string;
  label: string;
  description: string;
};

export function getGsdPhaseSuggestions(cwd: string): GsdPhaseSuggestion[] {
  const phases = readRoadmapPhases(cwd);
  if (phases.length === 0) {
    return [];
  }
  const current = resolveCurrentPhase(cwd)?.phase.number;
  const next =
    phases.find((phase) => phase.plans.some((plan) => !plan.completed))?.number ??
    resolveNextPlan(cwd)?.phase.number;

  return phases
    .map((phase) => {
      const incompletePlans = phase.plans.filter((plan) => !plan.completed);
      const markers = [
        phase.number === next ? "next" : undefined,
        phase.number === current ? "current" : undefined,
        incompletePlans.length > 0 ? `${incompletePlans.length} open` : "done",
      ].filter((value): value is string => value !== undefined);
      return {
        suggestion: {
          value: phase.number,
          label: `${phase.number} ${phase.name}`,
          description: markers.join(" • "),
        },
        rank:
          (phase.number === next ? 0 : 1) +
          (incompletePlans.length > 0 ? 0 : 2) +
          (phase.number === current ? 1 : 0),
      };
    })
    .toSorted(
      (left, right) =>
        left.rank - right.rank || left.suggestion.value.localeCompare(right.suggestion.value),
    )
    .map((entry) => entry.suggestion);
}

export function getGsdSubcommandHint(cwd: string, subcommand: string): string | undefined {
  const progress = computeProgress(cwd);
  const stats = computeStats(cwd);
  const health = computeHealth(cwd);
  const snapshot = readPlanningSnapshot(cwd);
  const next = resolveNextPlan(cwd);

  switch (subcommand) {
    case "map-codebase":
      return snapshot.project === undefined
        ? "bootstrap docs first"
        : "updates .planning/codebase/";
    case "discuss-phase":
      return next ? `target ${next.phase.number} ${next.phase.name}` : undefined;
    case "plan-phase":
      return next ? `next ${next.phase.number} ${next.planId ?? "plan"}` : undefined;
    case "execute-phase":
      return next ? `exec ${next.phase.number} ${next.planId ?? "phase"}` : undefined;
    case "verify-work":
      return next ? `verify ${next.phase.number} ${next.planId ?? "phase"}` : undefined;
    case "validate-phase":
      if (progress.currentPhase === undefined) {
        return undefined;
      }
      return `phase ${progress.currentPhase}`;
    case "next":
      return next ? `advance to ${next.phase.number} ${next.planId ?? "plan"}` : undefined;
    case "progress":
      return `${progress.percent}% ${progress.status.toLowerCase()}`;
    case "new-milestone":
      return resolveCurrentMilestone(cwd)?.version ?? "start next cycle";
    case "complete-milestone":
      return resolveCurrentMilestone(cwd)?.version ?? "archive current";
    case "milestone-summary":
      return listArchivedMilestones(cwd).at(-1)?.version ?? "report current";
    case "debug":
      return `${listDebugSessions(cwd).length} active sessions`;
    case "stats":
      return `${stats.phaseCount} phases • ${stats.planCount} plans`;
    case "health":
      return health.healthy ? "healthy" : `${health.issues.length} issues`;
    default:
      return undefined;
  }
}

export function getGsdMilestoneSuggestions(cwd: string): GsdSimpleSuggestion[] {
  const current = resolveCurrentMilestone(cwd);
  const archived = listArchivedMilestones(cwd);
  const suggestions: GsdSimpleSuggestion[] = [];
  if (current) {
    suggestions.push({
      value: current.version,
      label: current.version,
      description: `current • ${current.name}`,
    });
  }
  for (const milestone of archived) {
    if (milestone.version === current?.version) {
      continue;
    }
    suggestions.push({
      value: milestone.version,
      label: milestone.version,
      description: "archived milestone",
    });
  }
  return suggestions;
}

export function getGsdDebugSuggestions(cwd: string | undefined): GsdSimpleSuggestion[] {
  const items: GsdSimpleSuggestion[] = [
    { value: "list", label: "list", description: "List active sessions" },
    { value: "status", label: "status", description: "Inspect session by slug" },
    { value: "continue", label: "continue", description: "Resume session by slug" },
  ];
  if (cwd === undefined) {
    return items;
  }
  return [
    ...items,
    ...listDebugSessions(cwd).map((session) => ({
      value: session.slug,
      label: session.slug,
      description: `${session.frontmatter.status} • ${session.nextAction ?? "next unknown"}`,
    })),
  ];
}
