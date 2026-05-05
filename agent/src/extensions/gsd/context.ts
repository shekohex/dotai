import { detectExistingPlanning } from "./state/detect.js";
import { computeProgress } from "./state/progress.js";
import { readPlanningSnapshot } from "./state/read.js";
import { computeStats } from "./state/stats.js";

export function buildGsdSystemContext(cwd: string): string {
  const existing = detectExistingPlanning(cwd);
  if (!existing.valid) {
    return "";
  }

  const snapshot = readPlanningSnapshot(cwd);
  const progress = computeProgress(cwd);
  const stats = computeStats(cwd);

  return [
    "GSD Planning Context",
    `Project: ${existing.projectName ?? "unknown"}`,
    `Phase: ${progress.currentPhase ?? "-"} ${progress.currentPhaseName ?? "-"}`.trim(),
    `Plan: ${progress.currentPlan ?? "-"}`,
    `Status: ${progress.status}`,
    `Progress: ${progress.percent}%`,
    `Phases: ${stats.phaseCount}`,
    `Plans: ${stats.planCount}`,
    `Pending todos: ${snapshot.pendingTodos.length}`,
  ].join("\n");
}
