import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanFile } from "./read.js";
import { resolvePhasesDir, resolvePlanningDir } from "../shared.js";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases, type RoadmapPhase } from "./roadmap.js";

export type CurrentPhaseSelection = {
  phase: RoadmapPhase;
  phaseDir: string;
  phaseFilePrefix: string;
};

export type NextPlanSelection = {
  phase: RoadmapPhase;
  phaseDir: string;
  phaseFilePrefix: string;
  planId?: string;
  totalPlans: number;
  reason: "phase-ready" | "plan-advanced" | "phase-advanced" | "complete";
};

const trackedStateKeys = ["current_phase", "current_phase_name", "current_plan", "status"] as const;

type TrackedStateKey = (typeof trackedStateKeys)[number];

function toPhaseDirName(phase: RoadmapPhase): string {
  const normalized = phase.name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return `${phase.number}-${normalized || "phase"}`;
}

function planFilePrefix(phaseNumber: string): string {
  return phaseNumber.includes(".") ? phaseNumber : phaseNumber.padStart(2, "0");
}

export function resolveCurrentPhase(
  cwd: string,
  requestedPhase?: string,
): CurrentPhaseSelection | undefined {
  const snapshot = readPlanningSnapshot(cwd);
  const phases = readRoadmapPhases(cwd);
  if (phases.length === 0) {
    return undefined;
  }
  const requested = requestedPhase ?? snapshot.state?.current_phase;
  const active =
    phases.find((phase) => phase.number === requested) ??
    phases.find((phase) => phase.plans.some((plan) => !plan.completed)) ??
    phases[0];
  const phaseDir = join(resolvePhasesDir(cwd), toPhaseDirName(active));
  return {
    phase: active,
    phaseDir,
    phaseFilePrefix: planFilePrefix(active.number),
  };
}

export function ensureCurrentPhaseDir(cwd: string, requestedPhase?: string): CurrentPhaseSelection {
  const selected = resolveCurrentPhase(cwd, requestedPhase);
  if (!selected) {
    throw new Error("ROADMAP.md has no phase definitions");
  }
  mkdirSync(selected.phaseDir, { recursive: true });
  return selected;
}

function normalizePlanId(fileName: string): string {
  return fileName.replace("-PLAN.md", "");
}

function findIncompletePlan(plans: PlanFile[]): PlanFile | undefined {
  return plans.find((plan) => !plan.completed);
}

function phaseSnapshotByNumber(
  snapshot: ReturnType<typeof readPlanningSnapshot>,
  phase: RoadmapPhase,
) {
  return snapshot.phases.find((entry) => entry.id === toPhaseDirName(phase));
}

export function resolveNextPlan(
  cwd: string,
  requestedPhase?: string,
): NextPlanSelection | undefined {
  const snapshot = readPlanningSnapshot(cwd);
  const phases = readRoadmapPhases(cwd);
  if (phases.length === 0) {
    return undefined;
  }

  const currentPhaseNumber = requestedPhase ?? snapshot.state?.current_phase;
  const currentPlanId = snapshot.state?.current_plan;
  const currentPhaseIndex = Math.max(
    0,
    phases.findIndex((phase) => phase.number === currentPhaseNumber),
  );

  for (let index = currentPhaseIndex; index < phases.length; index += 1) {
    const phase = phases[index];
    if (phase === undefined) {
      continue;
    }
    const phaseDir = join(resolvePhasesDir(cwd), toPhaseDirName(phase));
    const phaseFilePrefix = planFilePrefix(phase.number);
    const phaseSnapshot = phaseSnapshotByNumber(snapshot, phase);
    const plans = phaseSnapshot?.plans ?? [];
    const totalPlans = plans.length;

    if (totalPlans === 0) {
      return {
        phase,
        phaseDir,
        phaseFilePrefix,
        totalPlans: 0,
        reason: "phase-ready",
      };
    }

    if (index === currentPhaseIndex) {
      const currentIndex =
        currentPlanId !== undefined && currentPlanId.length > 0
          ? plans.findIndex((plan) => normalizePlanId(plan.fileName) === currentPlanId)
          : -1;
      const afterCurrent = currentIndex >= 0 ? plans.slice(currentIndex + 1) : plans;
      const nextInPhase = findIncompletePlan(afterCurrent);
      if (nextInPhase) {
        return {
          phase,
          phaseDir,
          phaseFilePrefix,
          planId: normalizePlanId(nextInPhase.fileName),
          totalPlans,
          reason: currentIndex >= 0 ? "plan-advanced" : "phase-ready",
        };
      }
    }

    const firstIncomplete = findIncompletePlan(plans);
    if (firstIncomplete) {
      return {
        phase,
        phaseDir,
        phaseFilePrefix,
        planId: normalizePlanId(firstIncomplete.fileName),
        totalPlans,
        reason: index === currentPhaseIndex ? "phase-ready" : "phase-advanced",
      };
    }
  }

  const lastPhase = phases.at(-1);
  if (!lastPhase) {
    return undefined;
  }
  return {
    phase: lastPhase,
    phaseDir: join(resolvePhasesDir(cwd), toPhaseDirName(lastPhase)),
    phaseFilePrefix: planFilePrefix(lastPhase.number),
    totalPlans: phaseSnapshotByNumber(snapshot, lastPhase)?.plans.length ?? 0,
    reason: "complete",
  };
}

export function writeStateFields(
  cwd: string,
  values: Partial<Record<TrackedStateKey, string>>,
): void {
  const planningDir = resolvePlanningDir(cwd);
  mkdirSync(planningDir, { recursive: true });
  const statePath = join(planningDir, "STATE.md");
  const snapshot = readPlanningSnapshot(cwd);
  const rawState = existsSync(statePath) ? readFileSync(statePath, "utf8") : undefined;
  const next: Record<TrackedStateKey, string> = {
    current_phase: values.current_phase ?? toTrackedStateValue(snapshot.state?.current_phase),
    current_phase_name: values.current_phase_name ?? snapshot.state?.current_phase_name ?? "",
    current_plan: values.current_plan ?? snapshot.state?.current_plan ?? "",
    status: values.status ?? snapshot.state?.status ?? "",
  };
  if (rawState !== undefined && rawState.startsWith("---\n")) {
    writeFileSync(statePath, updateFrontmatterDocument(rawState, next), "utf8");
    return;
  }
  writeFileSync(statePath, updateLooseStateDocument(rawState, next), "utf8");
}

function updateFrontmatterDocument(
  content: string,
  values: Record<TrackedStateKey, string>,
): string {
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return content;
  }
  const frontmatterLines = content.slice(4, end).split("\n");
  const body = content.slice(end + 5);
  const updated = updateKeyValueLines(frontmatterLines, values);
  return `---\n${updated.join("\n")}\n---\n${body}`;
}

function updateLooseStateDocument(
  content: string | undefined,
  values: Record<TrackedStateKey, string>,
): string {
  const source = content ?? "";
  const lines = source.length > 0 ? source.split("\n") : [];
  const updated = updateKeyValueLines(lines, values);
  return `${updated.join("\n").replace(/\n*$/u, "")}\n`;
}

function updateKeyValueLines(lines: string[], values: Record<TrackedStateKey, string>): string[] {
  const updated = [...lines];
  const matchedKeys = new Set<TrackedStateKey>();

  for (let index = 0; index < updated.length; index += 1) {
    const line = updated[index];
    if (line === undefined) {
      continue;
    }
    for (const key of trackedStateKeys) {
      if (!line.startsWith(`${key}:`)) {
        continue;
      }
      updated[index] = `${key}: ${values[key]}`;
      matchedKeys.add(key);
      break;
    }
  }

  const missingKeys = trackedStateKeys.filter((key) => !matchedKeys.has(key));
  if (missingKeys.length === 0) {
    return updated;
  }

  const insertedLines = missingKeys.map((key) => `${key}: ${values[key]}`);
  const insertionIndex = findMetadataInsertionIndex(updated);
  const separator = needsSeparator(updated, insertionIndex) ? [""] : [];
  return [
    ...updated.slice(0, insertionIndex),
    ...insertedLines,
    ...separator,
    ...updated.slice(insertionIndex),
  ];
}

function toTrackedStateValue(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

function findMetadataInsertionIndex(lines: string[]): number {
  const firstBlank = lines.findIndex((line) => line.trim().length === 0);
  return Math.max(firstBlank, 0);
}

function needsSeparator(lines: string[], insertionIndex: number): boolean {
  const nextLine = lines[insertionIndex];
  return nextLine !== undefined && nextLine.trim().length > 0;
}
