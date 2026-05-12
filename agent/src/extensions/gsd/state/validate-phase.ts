import { execFileSync } from "node:child_process";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { resolveGsdBundlePath } from "../resources.js";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases, type RoadmapPhase } from "./roadmap.js";
import { resolveCurrentPhase, type CurrentPhaseSelection } from "./runtime.js";

type ValidatePhaseSelection = CurrentPhaseSelection & {
  summaryCount: number;
  validationExists: boolean;
  validationTargetPath: string;
  validationTargetMode: "create" | "update";
};

const ValidatePhasePreflightSchema = Type.Object(
  {
    ready: Type.Boolean(),
    failure_reason: Type.Union([Type.String(), Type.Null()]),
    nyquist_validation_enabled: Type.Boolean(),
    validation_target_path: Type.Union([Type.String(), Type.Null()]),
    validation_target_mode: Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Null(),
    ]),
  },
  { additionalProperties: true },
);

type ValidatePhasePreflight = Static<typeof ValidatePhasePreflightSchema>;

type ValidatePhasePreflightResult =
  | { ok: true; value: ValidatePhasePreflight }
  | { ok: false; error: string };

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

function hasUnexpectedSummaryIds(
  roadmapPhase: RoadmapPhase,
  phaseSnapshot: ReturnType<typeof readPlanningSnapshot>["phases"][number] | undefined,
): boolean {
  if (phaseSnapshot === undefined || phaseSnapshot.summaries.length === 0) {
    return false;
  }

  const roadmapPlanIds = new Set(roadmapPhase.plans.map((plan) => plan.id));
  return phaseSnapshot.summaries
    .map(normalizeSummaryId)
    .some((summaryId) => !roadmapPlanIds.has(summaryId));
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

function runValidatePhasePreflight(cwd: string, phaseNumber: string): ValidatePhasePreflightResult {
  const toolPath = resolveGsdBundlePath("bin", "gsd-tools.cjs");

  try {
    const stdout = execFileSync(
      process.execPath,
      [toolPath, "init", "validate-phase", phaseNumber],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const parsed = JSON.parse(stdout) as unknown;
    if (!Value.Check(ValidatePhasePreflightSchema, parsed)) {
      return {
        ok: false,
        error: "validate-phase preflight returned invalid JSON shape",
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    if (error instanceof Error) {
      return {
        ok: false,
        error: error.message,
      };
    }
    return {
      ok: false,
      error: "validate-phase preflight failed",
    };
  }
}

function findHighestLocalPhaseWithSummaries(
  roadmapPhases: RoadmapPhase[],
  byNumber: Map<string | undefined, ReturnType<typeof readPlanningSnapshot>["phases"][number]>,
):
  | {
      roadmapPhase: RoadmapPhase;
      phaseSnapshot: ReturnType<typeof readPlanningSnapshot>["phases"][number];
    }
  | undefined {
  return [...byNumber.entries()]
    .filter(
      (entry): entry is [string, ReturnType<typeof readPlanningSnapshot>["phases"][number]] => {
        const [phaseNumber, phaseSnapshot] = entry;
        return (
          phaseNumber !== undefined &&
          phaseSnapshot !== undefined &&
          phaseSnapshot.summaries.length > 0
        );
      },
    )
    .map(([phaseNumber, phaseSnapshot]) => ({
      roadmapPhase: findPhaseByNumber(roadmapPhases, phaseNumber),
      phaseSnapshot,
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        roadmapPhase: RoadmapPhase;
        phaseSnapshot: ReturnType<typeof readPlanningSnapshot>["phases"][number];
      } => candidate.roadmapPhase !== undefined,
    )
    .toSorted((left, right) =>
      comparePhaseNumbers(left.roadmapPhase.number, right.roadmapPhase.number),
    )
    .at(-1);
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
              roadmapPhase !== undefined &&
              isPhaseCompletedLocally(roadmapPhase, phaseSnapshot) &&
              !hasUnexpectedSummaryIds(roadmapPhase, phaseSnapshot)
            );
          })(),
      )
      .map(([phaseNumber]) => phaseNumber)
      .filter((phaseNumber): phaseNumber is string => phaseNumber !== undefined)
      .toSorted(comparePhaseNumbers)
      .at(-1);

  if (selectedPhaseNumber === undefined) {
    const highestLocalPhase = findHighestLocalPhaseWithSummaries(roadmapPhases, byNumber);
    if (
      requestedPhase === undefined &&
      highestLocalPhase !== undefined &&
      hasUnexpectedSummaryIds(highestLocalPhase.roadmapPhase, highestLocalPhase.phaseSnapshot)
    ) {
      return {
        error: `Cannot run /gsd validate-phase: phase ${highestLocalPhase.roadmapPhase.number} has malformed or non-roadmap SUMMARY.md artifacts.`,
      };
    }

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
  if (hasUnexpectedSummaryIds(roadmapPhase, phaseSnapshot)) {
    return {
      error: `Cannot run /gsd validate-phase: phase ${roadmapPhase.number} has malformed or non-roadmap SUMMARY.md artifacts.`,
    };
  }

  if (!isPhaseCompletedLocally(roadmapPhase, phaseSnapshot)) {
    return {
      error: `Cannot run /gsd validate-phase: phase ${roadmapPhase.number} is not locally complete enough yet. Need SUMMARY evidence for every roadmap plan before validation.`,
    };
  }

  const summaryCount = phaseSnapshot?.summaries.length ?? 0;
  const validationExists = (phaseSnapshot?.validations.length ?? 0) > 0;
  if (summaryCount === 0) {
    return {
      error: `Cannot run /gsd validate-phase: phase ${roadmapPhase.number} has no SUMMARY.md artifacts.`,
    };
  }

  const preflight = runValidatePhasePreflight(cwd, roadmapPhase.number);
  if (!preflight.ok) {
    return {
      error: `Cannot run /gsd validate-phase: ${preflight.error}.`,
    };
  }

  if (!preflight.value.nyquist_validation_enabled || !preflight.value.ready) {
    return {
      error: `Cannot run /gsd validate-phase: ${preflight.value.failure_reason ?? "validate-phase preflight failed."}`,
    };
  }

  if (
    preflight.value.validation_target_path === null ||
    preflight.value.validation_target_mode === null
  ) {
    return {
      error:
        "Cannot run /gsd validate-phase: validate-phase preflight returned no canonical validation target.",
    };
  }

  return {
    selection: {
      ...selection,
      summaryCount,
      validationExists,
      validationTargetPath: preflight.value.validation_target_path,
      validationTargetMode: preflight.value.validation_target_mode,
    },
  };
}
