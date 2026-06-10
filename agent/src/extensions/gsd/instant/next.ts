import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdCommandArgs } from "../args.js";
import { handleGsdCompleteMilestone } from "../lifecycle/complete-milestone.js";
import { handleGsdDiscussPhase } from "../lifecycle/discuss-phase.js";
import { handleGsdExecutePhase } from "../lifecycle/execute-phase.js";
import { handleGsdPlanPhase } from "../lifecycle/plan-phase.js";
import { handleGsdVerifyWork } from "../lifecycle/verify-work.js";
import { readPlanningSnapshot } from "../state/read.js";
import { readRoadmapPhases, type RoadmapPhase } from "../state/roadmap.js";
import { readBlockingContinueHereFile } from "../state/discuss.js";
import { resolveNextPlan } from "../state/runtime.js";

export const NextOutputSchema = Type.Object(
  {
    advanced: Type.Boolean(),
    previousPlan: Type.Optional(Type.String()),
    currentPlan: Type.Optional(Type.String()),
    totalPlans: Type.Optional(Type.Integer()),
    reason: Type.String(),
    newPhase: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type NextOutput = Static<typeof NextOutputSchema>;

type SupportedNextRoute =
  | "discuss-phase"
  | "plan-phase"
  | "execute-phase"
  | "verify-work"
  | "complete-milestone";

type RoutedNextOutput = {
  advanced: boolean;
  reason: string;
  route?: SupportedNextRoute;
  newPhase?: string;
};

function routeRequiresWorkflowSession(route: SupportedNextRoute): boolean {
  return route === "execute-phase" || route === "verify-work" || route === "complete-milestone";
}

const UatStatusSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("testing"),
      Type.Literal("partial"),
      Type.Literal("complete"),
      Type.Literal("diagnosed"),
    ]),
  },
  { additionalProperties: true },
);

function hasBlockingStatus(status: string | undefined): boolean {
  return status !== undefined && /\b(blocked|error)\b/iu.test(status);
}

function hasPausedStatus(status: string | undefined): boolean {
  return status !== undefined && /\b(paused|stopped)\b/iu.test(status);
}

function toPhaseDirName(phase: RoadmapPhase): string {
  const normalized = phase.name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return `${phase.number}-${normalized || "phase"}`;
}

function canonicalizePhaseNumber(value: string): string {
  return value
    .trim()
    .split(".")
    .map((segment) => String(Number.parseInt(segment, 10)))
    .join(".");
}

function extractLeadingPhaseNumber(value: string): string {
  const match = value.match(/^(\d+(?:\.\d+)?)/u);
  return canonicalizePhaseNumber(match?.[1] ?? value);
}

function phaseNumbersMatch(left: string, right: string): boolean {
  return canonicalizePhaseNumber(left) === canonicalizePhaseNumber(right);
}

function normalizeSummaryId(fileName: string): string {
  return fileName.replace(/-SUMMARY\.md$/u, "");
}

function normalizePlanArtifactId(value: string): string {
  const match = value.match(/^(\d+(?:\.\d+)?)-(\d+)(?:-(?:PLAN|SUMMARY)\.md)?$/u);
  if (match?.[1] === undefined || match[2] === undefined) {
    return value;
  }

  return `${canonicalizePhaseNumber(match[1])}-${String(Number.parseInt(match[2], 10))}`;
}

function isCanonicalPhaseArtifact(fileName: string, phaseNumber: string, suffix: string): boolean {
  const artifactPrefix = fileName.replace(suffix, "");
  return canonicalizePhaseNumber(artifactPrefix) === canonicalizePhaseNumber(phaseNumber);
}

function hasCanonicalPhaseArtifact(
  fileNames: string[] | undefined,
  phaseNumber: string,
  suffix: string,
): boolean {
  return (
    fileNames?.some((fileName) => isCanonicalPhaseArtifact(fileName, phaseNumber, suffix)) === true
  );
}

function countRoadmapMatchingSummaries(
  phaseSnapshot: ReturnType<typeof findPhaseSnapshot>,
  phase: RoadmapPhase,
): number {
  if (phaseSnapshot === undefined) {
    return 0;
  }

  if (phase.plans.length === 0) {
    return phaseSnapshot.summaries.length;
  }

  const roadmapPlanIds = new Set(phase.plans.map((plan) => normalizePlanArtifactId(plan.id)));
  return phaseSnapshot.summaries.filter((fileName) =>
    roadmapPlanIds.has(normalizePlanArtifactId(normalizeSummaryId(fileName))),
  ).length;
}

function countRoadmapMatchingPlans(
  phaseSnapshot: ReturnType<typeof findPhaseSnapshot>,
  phase: RoadmapPhase,
): number {
  if (phaseSnapshot === undefined) {
    return 0;
  }

  if (phase.plans.length === 0) {
    return phaseSnapshot.plans.length;
  }

  const roadmapPlanIds = new Set(phase.plans.map((plan) => normalizePlanArtifactId(plan.id)));
  return phaseSnapshot.plans.filter((plan) =>
    roadmapPlanIds.has(normalizePlanArtifactId(plan.fileName.replace(/-PLAN\.md$/u, ""))),
  ).length;
}

function readLatestVerificationStatus(
  phaseSnapshot: ReturnType<typeof findPhaseSnapshot>,
): "passed" | "gaps_found" | "human_needed" | undefined {
  const phaseNumber =
    phaseSnapshot === undefined ? undefined : extractLeadingPhaseNumber(phaseSnapshot.id);
  const fileName = phaseSnapshot?.verifications
    .filter((verificationFileName) =>
      phaseNumber === undefined
        ? false
        : isCanonicalPhaseArtifact(verificationFileName, phaseNumber, "-VERIFICATION.md"),
    )
    .toSorted((left, right) => left.localeCompare(right))
    .at(-1);
  if (phaseSnapshot === undefined || fileName === undefined) {
    return undefined;
  }
  const content = readFileSync(join(phaseSnapshot.path, fileName), "utf8");
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
  const statusMatch = frontmatter
    .match(/^status:\s*(.+)$/mu)?.[1]
    ?.trim()
    .toLowerCase();
  if (
    statusMatch === "passed" ||
    statusMatch === "approved" ||
    statusMatch === "complete" ||
    statusMatch === "ready_for_closeout" ||
    statusMatch === "ready_for_metadata_closeout"
  ) {
    return "passed";
  }
  if (statusMatch === "gaps_found" || statusMatch === "human_needed") {
    return statusMatch;
  }
  const verifiedMatch = frontmatter
    .match(/^verified:\s*(.+)$/mu)?.[1]
    ?.trim()
    .toLowerCase();
  if (verifiedMatch === "true" || verifiedMatch === "passed" || verifiedMatch === "approved") {
    return "passed";
  }
  if (verifiedMatch === "false") {
    return "gaps_found";
  }
  return undefined;
}

function findBlockingDiscussCheckpoint(
  snapshot: ReturnType<typeof readPlanningSnapshot>,
  phases: RoadmapPhase[],
): { phase: string; path: string } | undefined {
  for (const phase of phases) {
    const phaseSnapshot = snapshot.phases.find((item) =>
      phaseNumbersMatch(extractLeadingPhaseNumber(item.id), phase.number),
    );
    const path =
      phaseSnapshot === undefined ? undefined : join(phaseSnapshot.path, "DISCUSS-CHECKPOINT.json");
    if (path !== undefined && existsSync(path)) {
      return { phase: phase.number, path };
    }
  }

  for (const phaseSnapshot of snapshot.phases) {
    const phaseNumber = extractLeadingPhaseNumber(phaseSnapshot.id);
    if (phases.some((phase) => phaseNumbersMatch(phase.number, phaseNumber))) {
      continue;
    }
    const path = join(phaseSnapshot.path, "DISCUSS-CHECKPOINT.json");
    if (existsSync(path)) {
      return { phase: phaseNumber, path };
    }
  }
  return undefined;
}

function findBlockingVerificationFailure(
  snapshot: ReturnType<typeof readPlanningSnapshot>,
  phases: RoadmapPhase[],
): { phase: string; status: "gaps_found" | "human_needed" } | undefined {
  for (const phase of phases) {
    const phaseSnapshot = findPhaseSnapshot(snapshot, phase);
    const verificationStatus = readLatestVerificationStatus(phaseSnapshot);
    if (verificationStatus === "gaps_found" || verificationStatus === "human_needed") {
      const uatStatus =
        phaseSnapshot === undefined
          ? undefined
          : readPhaseUatStatus(phaseSnapshot.path, phase.number, phaseSnapshot.uats);
      if (uatStatus !== "complete") {
        return { phase: phase.number, status: verificationStatus };
      }
    }
  }
  return undefined;
}

function phaseNeedsDiscussPrep(
  cwd: string,
  phase: RoadmapPhase,
  phaseSnapshot: ReturnType<typeof findPhaseSnapshot>,
): boolean {
  const phaseDir = phaseSnapshot?.path ?? join(cwd, ".planning", "phases", toPhaseDirName(phase));
  return !existsSync(phaseDir) || phaseSnapshot?.context === undefined;
}

function findPhaseSnapshot(snapshot: ReturnType<typeof readPlanningSnapshot>, phase: RoadmapPhase) {
  return snapshot.phases.find((item) =>
    phaseNumbersMatch(extractLeadingPhaseNumber(item.id), phase.number),
  );
}

function readPhaseUatStatus(
  phasePath: string,
  phaseNumber: string,
  uatFiles: string[],
): string | undefined {
  const uatFile = uatFiles
    .filter((fileName) => isCanonicalPhaseArtifact(fileName, phaseNumber, "-UAT.md"))
    .toSorted((left, right) => left.localeCompare(right))[0];
  if (uatFile === undefined) {
    return undefined;
  }
  const uatPath = join(phasePath, uatFile);
  if (!existsSync(uatPath)) {
    return undefined;
  }
  const content = readFileSync(uatPath, "utf8");
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/u);
  if (!frontmatterMatch) {
    return undefined;
  }
  const statusMatch = frontmatterMatch[1]?.match(/^status:\s*(.+)$/mu);
  const status = statusMatch?.[1]?.trim();
  const parsed = { status };
  if (!Value.Check(UatStatusSchema, parsed)) {
    return undefined;
  }
  return parsed.status;
}

function resolvePhaseStartIndex(
  snapshot: ReturnType<typeof readPlanningSnapshot>,
  phases: RoadmapPhase[],
  requestedPhase?: string,
): number {
  if (requestedPhase !== undefined) {
    return phases.findIndex((phase) => phaseNumbersMatch(phase.number, requestedPhase));
  }

  const statePhase = `${snapshot.state?.current_phase ?? ""}`.trim() || undefined;
  const statePhaseIndex =
    statePhase === undefined
      ? -1
      : phases.findIndex((phase) => phaseNumbersMatch(phase.number, statePhase));
  const earliestIncompletePhaseIndex = phases.findIndex((phase) => {
    const phaseSnapshot = findPhaseSnapshot(snapshot, phase);
    const localPlanCount = countRoadmapMatchingPlans(phaseSnapshot, phase);
    const totalPlans = phase.plans.length > 0 ? phase.plans.length : localPlanCount;
    const completedPlans = countRoadmapMatchingSummaries(phaseSnapshot, phase);
    const roadmapPhaseComplete =
      phase.plans.length > 0 && phase.plans.every((plan) => plan.completed);

    if (
      roadmapPhaseComplete &&
      localPlanCount === 0 &&
      completedPlans === 0 &&
      !hasCanonicalPhaseArtifact(phaseSnapshot?.verifications, phase.number, "-VERIFICATION.md") &&
      !hasCanonicalPhaseArtifact(phaseSnapshot?.uats, phase.number, "-UAT.md")
    ) {
      return false;
    }

    if (totalPlans === 0 || completedPlans < totalPlans) {
      return true;
    }

    return (
      !hasCanonicalPhaseArtifact(phaseSnapshot?.verifications, phase.number, "-VERIFICATION.md") &&
      !hasCanonicalPhaseArtifact(phaseSnapshot?.uats, phase.number, "-UAT.md")
    );
  });

  if (
    earliestIncompletePhaseIndex >= 0 &&
    (statePhaseIndex < 0 || earliestIncompletePhaseIndex < statePhaseIndex)
  ) {
    return earliestIncompletePhaseIndex;
  }

  return statePhaseIndex;
}

export function resolveNextRoute(cwd: string, requestedPhase?: string): RoutedNextOutput {
  const snapshot = readPlanningSnapshot(cwd);
  const phases = readRoadmapPhases(cwd);
  if (phases.length === 0) {
    return { advanced: false, reason: "no roadmap phases" };
  }

  if (
    requestedPhase !== undefined &&
    !phases.some((phase) => phaseNumbersMatch(phase.number, requestedPhase))
  ) {
    return { advanced: false, reason: `unknown phase override: ${requestedPhase}` };
  }

  const rootContinueHere = readBlockingContinueHereFile(
    join(cwd, ".planning", ".continue-here.md"),
  );
  if (rootContinueHere !== undefined) {
    return {
      advanced: false,
      reason: `blocked by ${rootContinueHere}; resume pending work before /gsd next`,
    };
  }

  if (snapshot.state?.paused_at !== undefined || hasPausedStatus(snapshot.state?.status)) {
    return {
      advanced: false,
      reason: `blocked by paused state${snapshot.state?.paused_at === undefined ? "" : ` at ${snapshot.state.paused_at}`}`,
    };
  }

  const checkpoint = findBlockingDiscussCheckpoint(snapshot, phases);
  if (checkpoint !== undefined) {
    return {
      advanced: false,
      reason: `blocked by discuss checkpoint in phase ${checkpoint.phase}; resume with /gsd discuss-phase ${checkpoint.phase}`,
    };
  }

  const verificationFailure = findBlockingVerificationFailure(snapshot, phases);
  if (verificationFailure !== undefined) {
    return {
      advanced: false,
      reason: `blocked by unresolved verification FAIL in phase ${verificationFailure.phase}; rerun /gsd verify-work ${verificationFailure.phase}`,
    };
  }

  const startIndex = resolvePhaseStartIndex(snapshot, phases, requestedPhase);

  for (let index = Math.max(startIndex, 0); index < phases.length; index += 1) {
    const phase = phases[index];
    if (phase === undefined) {
      continue;
    }
    const phaseSnapshot = findPhaseSnapshot(snapshot, phase);
    const localPlanCount = countRoadmapMatchingPlans(phaseSnapshot, phase);
    const totalPlans = phase.plans.length > 0 ? phase.plans.length : localPlanCount;
    const completedPlans = countRoadmapMatchingSummaries(phaseSnapshot, phase);
    const roadmapPhaseComplete =
      phase.plans.length > 0 && phase.plans.every((plan) => plan.completed);

    if (
      roadmapPhaseComplete &&
      localPlanCount === 0 &&
      completedPlans === 0 &&
      (phaseSnapshot?.verifications.length ?? 0) === 0 &&
      (phaseSnapshot?.uats.length ?? 0) === 0
    ) {
      continue;
    }

    if (totalPlans === 0 || (phase.plans.length > 0 && localPlanCount === 0)) {
      if (phaseNeedsDiscussPrep(cwd, phase, phaseSnapshot)) {
        return {
          advanced: true,
          route: "discuss-phase",
          reason: "phase discuss context missing",
          newPhase: phase.number,
        };
      }
      return {
        advanced: true,
        route: "plan-phase",
        reason: "missing plan artifacts",
        newPhase: phase.number,
      };
    }

    if (completedPlans < totalPlans) {
      return {
        advanced: true,
        route: "execute-phase",
        reason: completedPlans === 0 ? "phase ready to execute" : "phase execution in progress",
        newPhase: phase.number,
      };
    }

    const verificationStatus = readLatestVerificationStatus(phaseSnapshot);
    const uatStatus =
      phaseSnapshot === undefined
        ? undefined
        : readPhaseUatStatus(phaseSnapshot.path, phase.number, phaseSnapshot.uats);
    const phaseVerified = verificationStatus === "passed";
    const phaseAccepted = phaseVerified || uatStatus === "complete";
    if (!phaseAccepted) {
      const hasCanonicalUat =
        (phaseSnapshot?.uats.filter((fileName) =>
          isCanonicalPhaseArtifact(fileName, phase.number, "-UAT.md"),
        ).length ?? 0) > 0;
      const verifyReason = hasCanonicalUat
        ? "phase verification in progress"
        : "phase ready to verify";
      return {
        advanced: true,
        route: "verify-work",
        reason: verifyReason,
        newPhase: phase.number,
      };
    }
  }

  return {
    advanced: true,
    route: "complete-milestone",
    reason: "milestone ready to complete",
  };
}

export function computeNext(cwd: string, requestedPhase?: string): NextOutput {
  const nextPlan = resolveNextPlan(cwd, requestedPhase);
  if (nextPlan === undefined) {
    return {
      advanced: false,
      reason: "no plans",
    };
  }
  const snapshot = readPlanningSnapshot(cwd);
  return {
    advanced: nextPlan.reason !== "complete",
    previousPlan: snapshot.state?.current_plan,
    currentPlan: nextPlan.planId,
    totalPlans: nextPlan.totalPlans,
    reason: nextPlan.reason,
    newPhase: nextPlan.phase.number,
  };
}

async function dispatchNextRoute(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  route: SupportedNextRoute,
  phase: string | undefined,
): Promise<void> {
  if (route === "discuss-phase") {
    await handleGsdDiscussPhase(pi, ctx, { subcommand: "discuss-phase", phase });
    return;
  }

  if (route === "plan-phase") {
    await handleGsdPlanPhase(pi, ctx, { subcommand: "plan-phase", phase });
    return;
  }

  if (route === "execute-phase") {
    await handleGsdExecutePhase(
      pi,
      ctx,
      { subcommand: "execute-phase", phase },
      `execute-phase ${phase ?? ""}`.trim(),
    );
    return;
  }

  if (route === "verify-work") {
    await handleGsdVerifyWork(
      pi,
      ctx,
      { subcommand: "verify-work", phase },
      `verify-work ${phase ?? ""}`.trim(),
    );
    return;
  }

  await handleGsdCompleteMilestone(
    pi,
    ctx,
    { subcommand: "complete-milestone" },
    "complete-milestone",
  );
}

export async function handleGsdNext(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): Promise<void> {
  if (args.unsupportedModeError !== undefined) {
    ctx.ui.notify(args.unsupportedModeError, "warning");
    return;
  }

  const snapshot = readPlanningSnapshot(ctx.cwd);
  if (hasBlockingStatus(snapshot.state?.status) && args.force !== true) {
    ctx.ui.notify(
      `Next blocked by status: ${snapshot.state?.status ?? "unknown"}. Re-run with /gsd next --force to bypass.`,
      "warning",
    );
    return;
  }

  if (
    args.phase !== undefined &&
    !readRoadmapPhases(ctx.cwd).some((phase) => phaseNumbersMatch(phase.number, args.phase ?? ""))
  ) {
    ctx.ui.notify(`Unknown /gsd next phase override: ${args.phase}.`, "warning");
    return;
  }

  const canDispatchWorkflow =
    ctx.sessionManager !== undefined &&
    typeof ctx.fork === "function" &&
    typeof ctx.newSession === "function";

  const routedResult = resolveNextRoute(ctx.cwd, args.phase);
  if (!routedResult.advanced || routedResult.route === undefined) {
    ctx.ui.notify(`Next ${routedResult.reason}`, "warning");
    return;
  }

  if (!canDispatchWorkflow && routeRequiresWorkflowSession(routedResult.route)) {
    ctx.ui.notify(
      `Next requires workflow session for /gsd ${routedResult.route}${routedResult.newPhase === undefined ? "" : ` ${routedResult.newPhase}`}. Cannot safely fall back to pointer-only state updates.`,
      "warning",
    );
    return;
  }

  await dispatchNextRoute(pi, ctx, routedResult.route, routedResult.newPhase);
}
