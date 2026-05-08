import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases, type RoadmapPhase } from "./roadmap.js";
import { resolveCurrentPhase, type CurrentPhaseSelection } from "./runtime.js";

type ValidatePhaseSelection = CurrentPhaseSelection & {
  summaryCount: number;
  validationExists: boolean;
};

function normalizeSummaryId(fileName: string): string {
  return fileName.replace(/-SUMMARY\.md$/u, "");
}

function isPhaseCompletedLocally(
  roadmapPhase: RoadmapPhase,
  phaseSnapshot: ReturnType<typeof readPlanningSnapshot>["phases"][number] | undefined,
): boolean {
  if (phaseSnapshot === undefined || phaseSnapshot.summaries.length === 0) {
    return false;
  }

  const completedPlanIds = new Set([
    ...phaseSnapshot.plans
      .filter((plan) => plan.completed)
      .map((plan) => plan.fileName.replace(/-PLAN\.md$/u, "")),
    ...phaseSnapshot.summaries.map(normalizeSummaryId),
  ]);

  if (roadmapPhase.plans.length > 0) {
    return roadmapPhase.plans.every((plan) => completedPlanIds.has(plan.id));
  }

  return phaseSnapshot.plans.length > 0 && phaseSnapshot.plans.every((plan) => plan.completed);
}

function comparePhaseNumbers(left: string, right: string): number {
  const leftParts = left.split(".").map((value) => Number.parseInt(value, 10));
  const rightParts = right.split(".").map((value) => Number.parseInt(value, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function findPhaseByNumber(phases: RoadmapPhase[], phaseNumber: string): RoadmapPhase | undefined {
  return phases.find((phase) => phase.number === phaseNumber);
}

export function resolveValidatePhaseSelection(
  cwd: string,
  requestedPhase?: string,
): { selection?: ValidatePhaseSelection; error?: string } {
  const snapshot = readPlanningSnapshot(cwd);
  const roadmapPhases = readRoadmapPhases(cwd);
  if (roadmapPhases.length === 0) {
    return { error: "Cannot run /gsd validate-phase: ROADMAP.md has no phase definitions." };
  }

  const byNumber = new Map(
    snapshot.phases.map((phaseSnapshot) => {
      const number = phaseSnapshot.id.match(/(\d+(?:\.\d+)?)/u)?.[1];
      return [number, phaseSnapshot] as const;
    }),
  );

  const selectedPhaseNumber =
    requestedPhase ??
    [...byNumber.entries()]
      .filter(
        ([phaseNumber, phaseSnapshot]) =>
          phaseNumber !== undefined &&
          phaseSnapshot !== undefined &&
          (() => {
            const roadmapPhase = findPhaseByNumber(roadmapPhases, phaseNumber);
            return (
              roadmapPhase !== undefined && isPhaseCompletedLocally(roadmapPhase, phaseSnapshot)
            );
          })(),
      )
      .map(([phaseNumber]) => phaseNumber)
      .filter((phaseNumber): phaseNumber is string => phaseNumber !== undefined)
      .toSorted(comparePhaseNumbers)
      .at(-1);

  if (selectedPhaseNumber === undefined) {
    return {
      error:
        "Cannot run /gsd validate-phase: no completed local phase found. Need phase with at least one SUMMARY.md artifact.",
    };
  }

  const roadmapPhase = findPhaseByNumber(roadmapPhases, selectedPhaseNumber);
  if (roadmapPhase === undefined) {
    return {
      error: `Cannot run /gsd validate-phase: phase ${selectedPhaseNumber} not found in ROADMAP.md.`,
    };
  }

  const selection = resolveCurrentPhase(cwd, roadmapPhase.number);
  if (selection === undefined) {
    return {
      error: `Cannot run /gsd validate-phase: phase ${roadmapPhase.number} could not be resolved locally.`,
    };
  }

  const phaseSnapshot = byNumber.get(roadmapPhase.number);
  const summaryCount = phaseSnapshot?.summaries.length ?? 0;
  const validationExists = (phaseSnapshot?.validations.length ?? 0) > 0;
  if (summaryCount === 0) {
    return {
      error: `Cannot run /gsd validate-phase: phase ${roadmapPhase.number} has no SUMMARY.md artifacts.`,
    };
  }

  return {
    selection: {
      ...selection,
      summaryCount,
      validationExists,
    },
  };
}
