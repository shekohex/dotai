import { Type, type Static } from "typebox";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases } from "./roadmap.js";
import { resolveCurrentPhase } from "./runtime.js";

export const ProgressOutputSchema = Type.Object(
  {
    milestone: Type.Optional(Type.String()),
    currentPhase: Type.Optional(Type.String()),
    currentPhaseName: Type.Optional(Type.String()),
    currentPlan: Type.Optional(Type.String()),
    totalPhases: Type.Integer({ minimum: 0 }),
    totalPlansInPhase: Type.Integer({ minimum: 0 }),
    completedPlans: Type.Integer({ minimum: 0 }),
    percent: Type.Integer({ minimum: 0, maximum: 100 }),
    status: Type.String(),
    bar: Type.String(),
  },
  { additionalProperties: false },
);

export type ProgressOutput = Static<typeof ProgressOutputSchema>;

function buildBar(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

export function computeProgress(cwd: string): ProgressOutput {
  const snapshot = readPlanningSnapshot(cwd);
  const roadmapPhases = readRoadmapPhases(cwd);
  const phaseSnapshots = snapshot.phases;
  const totalPlansFromSnapshots = phaseSnapshots.reduce(
    (sum, phase) => sum + phase.plans.length,
    0,
  );
  const totalPlans =
    totalPlansFromSnapshots > 0
      ? totalPlansFromSnapshots
      : roadmapPhases.reduce((sum, phase) => sum + phase.plans.length, 0);
  const completedPlans = phaseSnapshots.reduce(
    (sum, phase) => sum + phase.plans.filter((plan) => plan.completed).length,
    0,
  );
  const current = resolveCurrentPhase(cwd);
  const currentPhase =
    toOptionalString(snapshot.state?.current_phase) ??
    current?.phase.number ??
    phaseSnapshots[0]?.id;
  const activePhase =
    phaseSnapshots.find((phase) => phase.id === current?.phaseDir.split("/").at(-1)) ??
    phaseSnapshots.find((phase) => phase.id === currentPhase);
  const totalPlansInPhase = activePhase?.plans.length ?? current?.phase.plans.length ?? 0;
  const percent = totalPlans === 0 ? 0 : Math.round((completedPlans / totalPlans) * 100);

  return {
    milestone: snapshot.state?.milestone,
    currentPhase,
    currentPhaseName: snapshot.state?.current_phase_name ?? activePhase?.name,
    currentPlan: snapshot.state?.current_plan,
    totalPhases: Math.max(phaseSnapshots.length, roadmapPhases.length),
    totalPlansInPhase,
    completedPlans,
    percent,
    status: snapshot.state?.status ?? (totalPlans === 0 ? "Not started" : "In progress"),
    bar: buildBar(percent),
  };
}

function toOptionalString(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}
