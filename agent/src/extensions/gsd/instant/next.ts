import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdCommandArgs } from "../args.js";
import { handleGsdCompleteMilestone } from "../lifecycle/complete-milestone.js";
import { handleGsdExecutePhase } from "../lifecycle/execute-phase.js";
import { handleGsdPlanPhase } from "../lifecycle/plan-phase.js";
import { handleGsdVerifyWork } from "../lifecycle/verify-work.js";
import { readPlanningSnapshot } from "../state/read.js";
import { readRoadmapPhases, type RoadmapPhase } from "../state/roadmap.js";
import { resolveNextPlan, writeStateFields } from "../state/runtime.js";

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

type SupportedNextRoute = "plan-phase" | "execute-phase" | "verify-work" | "complete-milestone";

type RoutedNextOutput = {
  advanced: boolean;
  reason: string;
  route?: SupportedNextRoute;
  newPhase?: string;
};

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

function findPhaseSnapshot(snapshot: ReturnType<typeof readPlanningSnapshot>, phase: RoadmapPhase) {
  return snapshot.phases.find((item) => item.id.startsWith(`${phase.number}-`));
}

function readPhaseUatStatus(phasePath: string, uatFiles: string[]): string | undefined {
  const uatFile = uatFiles.toSorted((left, right) => left.localeCompare(right))[0];
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
    return phases.findIndex((phase) => phase.number === requestedPhase);
  }

  const statePhase = `${snapshot.state?.current_phase ?? ""}`.trim() || undefined;
  const statePhaseIndex =
    statePhase === undefined ? -1 : phases.findIndex((phase) => phase.number === statePhase);
  const earliestIncompletePhaseIndex = phases.findIndex((phase) => {
    const phaseSnapshot = findPhaseSnapshot(snapshot, phase);
    const totalPlans = Math.max(phase.plans.length, phaseSnapshot?.plans.length ?? 0);
    const completedPlans = phaseSnapshot?.summaries.length ?? 0;
    const roadmapPhaseComplete =
      phase.plans.length > 0 && phase.plans.every((plan) => plan.completed);

    if (
      roadmapPhaseComplete &&
      (phaseSnapshot?.plans.length ?? 0) === 0 &&
      completedPlans === 0 &&
      (phaseSnapshot?.verifications.length ?? 0) === 0 &&
      (phaseSnapshot?.uats.length ?? 0) === 0
    ) {
      return false;
    }

    if (totalPlans === 0 || completedPlans < totalPlans) {
      return true;
    }

    return (
      (phaseSnapshot?.verifications.length ?? 0) === 0 && (phaseSnapshot?.uats.length ?? 0) === 0
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

function resolveNextRoute(cwd: string, requestedPhase?: string): RoutedNextOutput {
  const snapshot = readPlanningSnapshot(cwd);
  const phases = readRoadmapPhases(cwd);
  if (phases.length === 0) {
    return { advanced: false, reason: "no roadmap phases" };
  }

  if (requestedPhase !== undefined && !phases.some((phase) => phase.number === requestedPhase)) {
    return { advanced: false, reason: `unknown phase override: ${requestedPhase}` };
  }

  const startIndex = resolvePhaseStartIndex(snapshot, phases, requestedPhase);

  for (let index = Math.max(startIndex, 0); index < phases.length; index += 1) {
    const phase = phases[index];
    if (phase === undefined) {
      continue;
    }
    const phaseSnapshot = findPhaseSnapshot(snapshot, phase);
    const totalPlans = Math.max(phase.plans.length, phaseSnapshot?.plans.length ?? 0);
    const completedPlans = phaseSnapshot?.summaries.length ?? 0;
    const roadmapPhaseComplete =
      phase.plans.length > 0 && phase.plans.every((plan) => plan.completed);

    if (
      roadmapPhaseComplete &&
      (phaseSnapshot?.plans.length ?? 0) === 0 &&
      completedPlans === 0 &&
      (phaseSnapshot?.verifications.length ?? 0) === 0 &&
      (phaseSnapshot?.uats.length ?? 0) === 0
    ) {
      continue;
    }

    if (totalPlans === 0 || (phase.plans.length > 0 && (phaseSnapshot?.plans.length ?? 0) === 0)) {
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

    if (
      (phaseSnapshot?.verifications.length ?? 0) === 0 &&
      (phaseSnapshot?.uats.length ?? 0) === 0
    ) {
      return {
        advanced: true,
        route: "verify-work",
        reason: "phase ready to verify",
        newPhase: phase.number,
      };
    }

    const uatStatus =
      phaseSnapshot === undefined
        ? undefined
        : readPhaseUatStatus(phaseSnapshot.path, phaseSnapshot.uats);
    if (
      (phaseSnapshot?.uats.length ?? 0) > 0 &&
      uatStatus !== "complete" &&
      uatStatus !== "diagnosed"
    ) {
      return {
        advanced: true,
        route: "verify-work",
        reason: "phase verification in progress",
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
    !readRoadmapPhases(ctx.cwd).some((phase) => phase.number === args.phase)
  ) {
    ctx.ui.notify(`Unknown /gsd next phase override: ${args.phase}.`, "warning");
    return;
  }

  const result = computeNext(ctx.cwd, args.phase);
  const canDispatchWorkflow =
    ctx.sessionManager !== undefined &&
    typeof ctx.fork === "function" &&
    typeof ctx.newSession === "function";

  if (result.reason.startsWith("unknown phase override:")) {
    ctx.ui.notify(`Unknown /gsd next phase override: ${args.phase}.`, "warning");
    return;
  }

  if (!canDispatchWorkflow) {
    if (!result.advanced) {
      ctx.ui.notify(`Next ${result.reason}`, "warning");
      return;
    }
    const nextSelection = resolveNextPlan(ctx.cwd, args.phase);
    if (!nextSelection) {
      ctx.ui.notify("Next no plans", "warning");
      return;
    }
    writeStateFields(ctx.cwd, {
      current_phase: nextSelection.phase.number,
      current_phase_name: nextSelection.phase.name,
      current_plan: nextSelection.planId ?? "",
      status: nextSelection.planId === undefined ? "Ready to plan" : "Ready to execute",
    });
    ctx.ui.notify(`Next phase=${result.newPhase ?? "-"} plan=${result.currentPlan}`, "info");
    return;
  }

  const routedResult = resolveNextRoute(ctx.cwd, args.phase);
  if (!routedResult.advanced || routedResult.route === undefined) {
    ctx.ui.notify(`Next ${routedResult.reason}`, "warning");
    return;
  }

  await dispatchNextRoute(pi, ctx, routedResult.route, routedResult.newPhase);
}
