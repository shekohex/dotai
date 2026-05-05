import { existsSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { resolvePlanningDir } from "../shared.js";
import { readPlanningSnapshot, readPlanningConfig, extractProjectName } from "./read.js";
import { readRoadmapPhases } from "./roadmap.js";
import { PlanningConfigSchema } from "./schema.js";

export type BrownfieldResult =
  | { valid: true; projectName: string | undefined; phaseCount: number }
  | { valid: false; reason: string };

export function detectExistingPlanning(cwd: string): BrownfieldResult {
  const planningDir = resolvePlanningDir(cwd);
  if (!existsSync(planningDir)) {
    return { valid: false, reason: "no .planning directory" };
  }

  const config = readPlanningConfig(cwd);
  if (config === undefined) {
    const configPath = join(planningDir, "config.json");
    if (!existsSync(configPath)) {
      return { valid: false, reason: "missing config.json" };
    }
    return { valid: false, reason: "config.json schema error" };
  }

  if (!Value.Check(PlanningConfigSchema, config)) {
    return { valid: false, reason: "config.json schema error" };
  }

  const snapshot = readPlanningSnapshot(cwd);
  if (snapshot.state === undefined && snapshot.roadmap === undefined) {
    return { valid: false, reason: "missing STATE.md and ROADMAP.md" };
  }
  const roadmapPhases = readRoadmapPhases(cwd);

  return {
    valid: true,
    projectName: extractProjectName(snapshot),
    phaseCount: Math.max(snapshot.phases.length, roadmapPhases.length),
  };
}
