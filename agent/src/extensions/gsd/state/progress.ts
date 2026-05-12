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
  const phasePlanTotals = new Map<string, number>();
  const completedPlanIdsByPhase = new Map<string, Set<string>>();

  for (const phase of roadmapPhases) {
    const phaseNumber = normalizePhaseNumber(phase.number);
    phasePlanTotals.set(phaseNumber, phase.plans.length);
    completedPlanIdsByPhase.set(
      phaseNumber,
      new Set(phase.plans.filter((plan) => plan.completed).map((plan) => plan.id)),
    );
  }

  for (const phase of phaseSnapshots) {
    const phaseNumber = extractPhaseNumber(phase.id);
    if (phaseNumber === undefined) {
      continue;
    }
    phasePlanTotals.set(
      phaseNumber,
      Math.max(phasePlanTotals.get(phaseNumber) ?? 0, phase.plans.length),
    );
    const completedPlanIds = completedPlanIdsByPhase.get(phaseNumber) ?? new Set<string>();
    for (const plan of phase.plans) {
      if (plan.completed) {
        completedPlanIds.add(plan.fileName.replace(/-PLAN\.md$/u, ""));
      }
    }
    completedPlanIdsByPhase.set(phaseNumber, completedPlanIds);
  }

  const totalPlans = [...phasePlanTotals.values()].reduce((sum, count) => sum + count, 0);
  const completedPlans = [...completedPlanIdsByPhase.values()].reduce(
    (sum, completedPlanIds) => sum + completedPlanIds.size,
    0,
  );
  const activePhase = resolveActiveProgressPhase({
    cwd,
    snapshot,
    roadmapPhases,
    phasePlanTotals,
    completedPlanIdsByPhase,
  });
  const percent = totalPlans === 0 ? 0 : Math.round((completedPlans / totalPlans) * 100);

  return {
    milestone: snapshot.state?.milestone,
    currentPhase: activePhase?.number,
    currentPhaseName: activePhase?.name,
    currentPlan: activePhase?.currentPlan,
    totalPhases: Math.max(phaseSnapshots.length, roadmapPhases.length),
    totalPlansInPhase: activePhase?.totalPlansInPhase ?? 0,
    completedPlans,
    percent,
    status: snapshot.state?.status ?? (totalPlans === 0 ? "Not started" : "In progress"),
    bar: buildBar(percent),
  };
}

function resolveActiveProgressPhase(input: {
  cwd: string;
  snapshot: ReturnType<typeof readPlanningSnapshot>;
  roadmapPhases: ReturnType<typeof readRoadmapPhases>;
  phasePlanTotals: Map<string, number>;
  completedPlanIdsByPhase: Map<string, Set<string>>;
}):
  | {
      number?: string;
      name?: string;
      currentPlan?: string;
      totalPlansInPhase: number;
    }
  | undefined {
  for (const roadmapPhase of input.roadmapPhases) {
    const phaseNumber = normalizePhaseNumber(roadmapPhase.number);
    const totalPlans = input.phasePlanTotals.get(phaseNumber) ?? roadmapPhase.plans.length;
    const completedPlans = input.completedPlanIdsByPhase.get(phaseNumber)?.size ?? 0;
    if (totalPlans === 0 || completedPlans >= totalPlans) {
      continue;
    }
    const currentPlan = roadmapPhase.plans.find(
      (plan) => !(input.completedPlanIdsByPhase.get(phaseNumber)?.has(plan.id) ?? false),
    )?.id;
    return {
      number: roadmapPhase.number,
      name: roadmapPhase.name,
      currentPlan,
      totalPlansInPhase: totalPlans,
    };
  }

  const current = resolveCurrentPhase(input.cwd);
  const currentPhase =
    toOptionalString(input.snapshot.state?.current_phase) ??
    current?.phase.number ??
    input.snapshot.phases[0]?.id;
  const activeSnapshot = input.snapshot.phases.find(
    (phase) => phase.id === current?.phaseDir.split("/").at(-1),
  );
  const fallbackSnapshot =
    activeSnapshot ?? input.snapshot.phases.find((phase) => phase.id === currentPhase);
  return {
    number: currentPhase,
    name: input.snapshot.state?.current_phase_name ?? fallbackSnapshot?.name ?? current?.phase.name,
    currentPlan: input.snapshot.state?.current_plan,
    totalPlansInPhase: fallbackSnapshot?.plans.length ?? current?.phase.plans.length ?? 0,
  };
}

function toOptionalString(value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function extractPhaseNumber(value: string): string | undefined {
  const match = value.match(/^(\d+(?:\.\d+)?)/u);
  return match === null ? undefined : normalizePhaseNumber(match[1]);
}

function normalizePhaseNumber(value: string): string {
  return value
    .trim()
    .split(".")
    .map((segment) => String(Number.parseInt(segment, 10)))
    .join(".");
}
