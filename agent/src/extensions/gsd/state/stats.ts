import { Type, type Static } from "typebox";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases } from "./roadmap.js";
import { resolveCurrentMilestone } from "./milestones.js";
import {
  canonicalizePhaseNumber,
  deriveStatsPhaseStatus,
  extractLeadingPhaseNumber,
  parseRequirementsProgress,
  type StatsPhaseStatus,
} from "./stats-support.js";

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

const StatsPhaseStatusSchema = Type.Union([
  Type.Literal("Not Started"),
  Type.Literal("In Progress"),
  Type.Literal("Executed"),
  Type.Literal("Human Needed"),
  Type.Literal("Complete"),
]);

const StatsPhaseSchema = Type.Object(
  {
    number: Type.String(),
    name: Type.String(),
    plans: Type.Integer({ minimum: 0 }),
    summaries: Type.Integer({ minimum: 0 }),
    status: StatsPhaseStatusSchema,
  },
  { additionalProperties: false },
);

export const StructuredStatsOutputSchema = Type.Object(
  {
    milestone_version: Type.String(),
    milestone_name: Type.String(),
    phases: Type.Array(StatsPhaseSchema),
    phases_completed: Type.Integer({ minimum: 0 }),
    phases_total: Type.Integer({ minimum: 0 }),
    total_plans: Type.Integer({ minimum: 0 }),
    total_summaries: Type.Integer({ minimum: 0 }),
    percent: Type.Integer({ minimum: 0 }),
    plan_percent: Type.Integer({ minimum: 0 }),
    requirements_total: Type.Integer({ minimum: 0 }),
    requirements_complete: Type.Integer({ minimum: 0 }),
    git_commits: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    git_first_commit_date: Type.Union([Type.String(), Type.Null()]),
    last_activity: Type.Union([Type.String(), Type.Null()]),
    verification_count: Type.Integer({ minimum: 0 }),
    open_blockers: Type.Integer({ minimum: 0 }),
    decisions_count: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type StructuredStatsOutput = Static<typeof StructuredStatsOutputSchema>;

export function computeStats(cwd: string): StatsOutput {
  const structured = computeStructuredStats(cwd);
  return {
    phaseCount: structured.phases_total,
    planCount: structured.total_plans,
    summaryCount: structured.total_summaries,
    verificationCount: structured.verification_count,
    openBlockers: structured.open_blockers,
    decisionsCount: structured.decisions_count,
  };
}

export function computeStructuredStats(cwd: string): StructuredStatsOutput {
  const snapshot = readPlanningSnapshot(cwd);
  const roadmapPhases = readRoadmapPhases(cwd);
  const milestone = resolveCurrentMilestone(cwd);
  const phaseScope = resolveMilestonePhaseNumbers(snapshot.roadmap, milestone?.version);
  const scopedSnapshotPhases =
    phaseScope === undefined
      ? snapshot.phases
      : snapshot.phases.filter((phase) => phaseScope.has(extractLeadingPhaseNumber(phase.id)));
  const scopedRoadmapPhases =
    phaseScope === undefined
      ? roadmapPhases
      : roadmapPhases.filter((phase) => phaseScope.has(canonicalizePhaseNumber(phase.number)));
  const blockers = snapshot.stateBody?.match(/blocker/gi)?.length ?? 0;
  const decisions = snapshot.project?.match(/^\|/gm)?.length ?? 0;
  const requirements = parseRequirementsProgress(snapshot.requirements);
  const phases = new Map<
    string,
    {
      number: string;
      name: string;
      plans: number;
      summaries: number;
      status: StatsPhaseStatus;
    }
  >();

  for (const phase of scopedRoadmapPhases) {
    const number = canonicalizePhaseNumber(phase.number);
    phases.set(number, {
      number,
      name: phase.name,
      plans: phase.plans.length,
      summaries: 0,
      status: "Not Started",
    });
  }

  let verificationCount = 0;
  for (const phase of scopedSnapshotPhases) {
    const number = extractLeadingPhaseNumber(phase.id);
    const existing = phases.get(number);
    const plans = phase.plans.length;
    const summaries = phase.summaries.length;
    const status = deriveStatsPhaseStatus(phase, existing?.plans ?? 0);
    phases.set(number, {
      number,
      name: existing?.name ?? phase.name,
      plans: Math.max(plans, existing?.plans ?? 0),
      summaries,
      status,
    });
    verificationCount += phase.verifications.length + phase.validations.length + phase.uats.length;
  }

  const sortedPhases = [...phases.values()].toSorted((left, right) =>
    left.number.localeCompare(right.number, undefined, { numeric: true }),
  );
  const totalPlans = sortedPhases.reduce((sum, phase) => sum + phase.plans, 0);
  const totalSummaries = sortedPhases.reduce((sum, phase) => sum + phase.summaries, 0);
  const completedPhases = sortedPhases.filter((phase) => phase.status === "Complete").length;
  const percent =
    sortedPhases.length > 0
      ? Math.min(100, Math.round((completedPhases / sortedPhases.length) * 100))
      : 0;
  const planPercent =
    totalPlans > 0 ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100)) : 0;

  return {
    milestone_version: milestone?.version ?? "current",
    milestone_name: milestone?.name ?? milestone?.version ?? "Current",
    phases: sortedPhases,
    phases_completed: completedPhases,
    phases_total: sortedPhases.length,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    percent,
    plan_percent: planPercent,
    requirements_total: requirements.total,
    requirements_complete: requirements.complete,
    git_commits: null,
    git_first_commit_date: null,
    last_activity: snapshot.state?.last_activity ?? null,
    verification_count: verificationCount,
    open_blockers: blockers,
    decisions_count: Math.max(0, decisions - 2),
  };
}

function resolveMilestonePhaseNumbers(
  roadmap: string | undefined,
  milestoneVersion: string | undefined,
): Set<string> | undefined {
  if (roadmap === undefined || milestoneVersion === undefined) {
    return undefined;
  }
  const milestoneLabelPattern = buildExactMilestoneLabelPattern(milestoneVersion);
  const milestonePattern = new RegExp(`^#{2,4}\\s+.*${milestoneLabelPattern}.*$`, "mu");
  const milestoneSummaryPattern = new RegExp(
    `<summary>.*${milestoneLabelPattern}.*<\\/summary>`,
    "iu",
  );
  const phasePattern = /^#{3,4}\s+Phase\s+(\d+(?:\.\d+)?)\s*:/gmu;
  const lines = roadmap.split("\n");
  const scopedLines: string[] = [];
  let insideMilestone = false;
  let milestoneContainer: "heading" | "details" | undefined;

  for (const line of lines) {
    if (milestonePattern.test(line)) {
      insideMilestone = true;
      milestoneContainer = "heading";
      scopedLines.push(line);
      continue;
    }

    if (milestoneSummaryPattern.test(line)) {
      insideMilestone = true;
      milestoneContainer = "details";
      scopedLines.push(line);
      continue;
    }

    if (
      insideMilestone &&
      milestoneContainer === "heading" &&
      /^#{2,4}\s+.*\bv\d+(?:\.\d+){0,2}\b.*$/u.test(line)
    ) {
      break;
    }

    if (insideMilestone) {
      scopedLines.push(line);
    }

    if (insideMilestone && milestoneContainer === "details" && /<\/details>/iu.test(line)) {
      break;
    }
  }

  const scopedContent = scopedLines.join("\n");
  const phaseMatches = [...scopedContent.matchAll(phasePattern)].map((match) =>
    canonicalizePhaseNumber(match[1] ?? ""),
  );
  return phaseMatches.length > 0 ? new Set(phaseMatches) : undefined;
}

function buildExactMilestoneLabelPattern(milestoneVersion: string): string {
  const escapedVersion = milestoneVersion.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(^|[^A-Za-z0-9.])${escapedVersion}([^A-Za-z0-9.]|$)`;
}
