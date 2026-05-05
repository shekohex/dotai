import { Type, type Static } from "typebox";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases } from "./roadmap.js";

export const StatsOutputSchema = Type.Object(
  {
    phaseCount: Type.Integer({ minimum: 0 }),
    planCount: Type.Integer({ minimum: 0 }),
    summaryCount: Type.Integer({ minimum: 0 }),
    verificationCount: Type.Integer({ minimum: 0 }),
    openBlockers: Type.Integer({ minimum: 0 }),
    decisionsCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type StatsOutput = Static<typeof StatsOutputSchema>;

export function computeStats(cwd: string): StatsOutput {
  const snapshot = readPlanningSnapshot(cwd);
  const roadmapPhases = readRoadmapPhases(cwd);
  const blockers = snapshot.stateBody?.match(/blocker/gi)?.length ?? 0;
  const decisions = snapshot.project?.match(/^\|/gm)?.length ?? 0;
  const planCountFromSnapshots = snapshot.phases.reduce(
    (sum, phase) => sum + phase.plans.length,
    0,
  );
  return {
    phaseCount: Math.max(snapshot.phases.length, roadmapPhases.length),
    planCount:
      planCountFromSnapshots > 0
        ? planCountFromSnapshots
        : roadmapPhases.reduce((sum, phase) => sum + phase.plans.length, 0),
    summaryCount: snapshot.phases.reduce((sum, phase) => sum + phase.summaries.length, 0),
    verificationCount: snapshot.phases.reduce(
      (sum, phase) =>
        sum + phase.verifications.length + phase.validations.length + phase.uats.length,
      0,
    ),
    openBlockers: blockers,
    decisionsCount: Math.max(0, decisions - 2),
  };
}
