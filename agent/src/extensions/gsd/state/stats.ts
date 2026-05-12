import { Type, type Static } from "typebox";
import { resolveCurrentMilestone } from "./milestones.js";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases } from "./roadmap.js";
import {
  canonicalizePhaseNumber,
  deriveStatsPhaseStatus,
  extractLeadingPhaseNumber,
  parseRequirementsProgress,
  readGitCommitCount,
  readGitFirstCommitDate,
  readLatestPlanningActivity,
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
  const milestoneName =
    milestone === undefined
      ? undefined
      : (resolveMilestoneName(snapshot.roadmap, milestone.version) ?? milestone.name);
  const phaseScope = resolveMilestonePhaseNumbers(snapshot.roadmap, milestone?.version);
  const scopedSnapshotPhases =
    phaseScope === undefined
      ? snapshot.phases
      : snapshot.phases.filter((phase) => phaseScope.has(extractLeadingPhaseNumber(phase.id)));
  const scopedRoadmapPhases =
    phaseScope === undefined
      ? roadmapPhases
      : roadmapPhases.filter((phase) => phaseScope.has(canonicalizePhaseNumber(phase.number)));
  const blockers = countActiveBlockers(snapshot.stateBody);
  const decisions = countProjectDecisionRows(snapshot.project);
  const requirements = parseRequirementsProgress(snapshot.requirements);
  const gitCommitCount = readGitCommitCount(cwd);
  const gitFirstCommitDate = readGitFirstCommitDate(cwd);
  const lastActivity = snapshot.state?.last_activity ?? readLatestPlanningActivity(cwd);
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
    verificationCount += phase.verifications.length;
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
    milestone_name: milestoneName ?? milestone?.version ?? "Current",
    phases: sortedPhases,
    phases_completed: completedPhases,
    phases_total: sortedPhases.length,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    percent,
    plan_percent: planPercent,
    requirements_total: requirements.total,
    requirements_complete: requirements.complete,
    git_commits: gitCommitCount,
    git_first_commit_date: gitFirstCommitDate,
    last_activity: lastActivity,
    verification_count: verificationCount,
    open_blockers: blockers,
    decisions_count: decisions,
  };
}

function countProjectDecisionRows(project: string | undefined): number {
  if (project === undefined) {
    return 0;
  }

  const lines = project.split("\n");
  let insideKeyDecisions = false;
  let rowCount = 0;
  let currentTableIsDecisionTable = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^##\s+Key Decisions\s*$/u.test(line.trim())) {
      insideKeyDecisions = true;
      currentTableIsDecisionTable = false;
      continue;
    }

    if (insideKeyDecisions && /^##\s+/u.test(trimmed)) {
      break;
    }

    if (!trimmed.startsWith("|")) {
      currentTableIsDecisionTable = false;
      continue;
    }

    if (!currentTableIsDecisionTable && isDecisionTableHeader(trimmed)) {
      currentTableIsDecisionTable = true;
      continue;
    }

    if (!currentTableIsDecisionTable && !insideKeyDecisions) {
      continue;
    }

    if (/^\|(?:\s*:?-+:?\s*\|)+$/u.test(trimmed)) {
      continue;
    }

    rowCount += 1;
  }

  return rowCount;
}

function countActiveBlockers(stateBody: string | undefined): number {
  if (stateBody === undefined) {
    return 0;
  }

  const lines = stateBody.split("\n");
  let insideBlockers = false;
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^###\s+Blockers\/Concerns\s*$/u.test(trimmed)) {
      insideBlockers = true;
      continue;
    }

    if (insideBlockers && /^##{1,3}\s+/u.test(trimmed)) {
      break;
    }

    if (!insideBlockers) {
      continue;
    }

    if (/^-\s+/u.test(trimmed) && !/^[-*]\s+None yet\.?$/iu.test(trimmed)) {
      count += 1;
    }
  }

  return count;
}

function isDecisionTableHeader(line: string): boolean {
  const columns = line
    .split("|")
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
  return columns.some((column) => column.toLowerCase() === "decision");
}

function resolveMilestoneName(
  roadmap: string | undefined,
  milestoneVersion: string | undefined,
): string | undefined {
  if (roadmap === undefined || milestoneVersion === undefined) {
    return undefined;
  }

  for (const line of roadmap.split("\n")) {
    if (!line.includes(milestoneVersion) || !lineHasExactMilestoneVersion(line, milestoneVersion)) {
      continue;
    }
    const derivedName = extractMilestoneNameFromLine(line, milestoneVersion);
    if (derivedName !== undefined) {
      return derivedName;
    }
  }

  return undefined;
}

function lineHasExactMilestoneVersion(line: string, milestoneVersion: string): boolean {
  const pattern = new RegExp(buildExactMilestoneLabelPattern(milestoneVersion), "u");
  return pattern.test(line);
}

function extractMilestoneNameFromLine(line: string, milestoneVersion: string): string | undefined {
  const summaryLine = line.replaceAll(/<\/?summary>/giu, "").trim();
  const headingLine = summaryLine.replace(/^#{2,4}\s+/u, "").trim();
  const milestoneIndex = headingLine.indexOf(milestoneVersion);
  if (milestoneIndex < 0) {
    return undefined;
  }

  const trailing = headingLine.slice(milestoneIndex + milestoneVersion.length).trim();
  if (trailing.length === 0) {
    return undefined;
  }

  const cleaned = trailing
    .replace(/^[-:–—]\s*/u, "")
    .replaceAll(/\(.*?\)/gu, "")
    .replace(/[-:–—]\s*(shipped|in progress|planned).*$/iu, "")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
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
  const milestoneRange = resolveMilestoneRangePhaseNumbers(roadmap, milestoneVersion);
  if (milestoneRange !== undefined) {
    return milestoneRange;
  }
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

function resolveMilestoneRangePhaseNumbers(
  roadmap: string,
  milestoneVersion: string,
): Set<string> | undefined {
  for (const line of roadmap.split("\n")) {
    if (!lineHasExactMilestoneVersion(line, milestoneVersion)) {
      continue;
    }
    const phaseNumbers = extractPhaseNumbersFromMilestoneLine(line);
    if (phaseNumbers !== undefined) {
      return phaseNumbers;
    }
  }
  return undefined;
}

function extractPhaseNumbersFromMilestoneLine(line: string): Set<string> | undefined {
  const rangeMatch = line.match(/\bPhases?\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/iu);
  if (rangeMatch?.[1] !== undefined && rangeMatch[2] !== undefined) {
    return buildPhaseRange(rangeMatch[1], rangeMatch[2]);
  }

  const singleMatch = line.match(/\bPhase\s+(\d+(?:\.\d+)?)(?!\s*-)/iu);
  if (singleMatch?.[1] !== undefined) {
    return new Set([canonicalizePhaseNumber(singleMatch[1])]);
  }

  return undefined;
}

function buildPhaseRange(start: string, end: string): Set<string> | undefined {
  const startValue = Number.parseFloat(start);
  const endValue = Number.parseFloat(end);
  if (!Number.isInteger(startValue) || !Number.isInteger(endValue) || endValue < startValue) {
    return undefined;
  }

  const values = new Set<string>();
  for (let current = startValue; current <= endValue; current += 1) {
    values.add(canonicalizePhaseNumber(String(current)));
  }
  return values;
}

function buildExactMilestoneLabelPattern(milestoneVersion: string): string {
  const escapedVersion = milestoneVersion.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(^|[^A-Za-z0-9.])${escapedVersion}([^A-Za-z0-9.]|$)`;
}
