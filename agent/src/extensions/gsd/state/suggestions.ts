import { computeHealth } from "./health.js";
import { computeProgress } from "./progress.js";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases } from "./roadmap.js";
import { resolveCurrentPhase, resolveNextPlan } from "./runtime.js";
import { computeStats } from "./stats.js";

export type GsdPhaseSuggestion = {
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
        : "updates research/CODEBASE_MAP.md";
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
    case "stats":
      return `${stats.phaseCount} phases • ${stats.planCount} plans`;
    case "health":
      return health.healthy ? "healthy" : `${health.issues.length} issues`;
    default:
      return undefined;
  }
}
