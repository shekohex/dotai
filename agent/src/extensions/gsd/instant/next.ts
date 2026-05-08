import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { GsdCommandArgs } from "../args.js";
import { resolveNextPlan, writeStateFields } from "../state/runtime.js";
import { readPlanningSnapshot } from "../state/read.js";
import { readRoadmapPhases } from "../state/roadmap.js";

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

export function handleGsdNext(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs = {},
): void {
  if (
    args.phase !== undefined &&
    !readRoadmapPhases(ctx.cwd).some((phase) => phase.number === args.phase)
  ) {
    ctx.ui.notify(`Unknown /gsd next phase override: ${args.phase}.`, "warning");
    return;
  }
  const result = computeNext(ctx.cwd, args.phase);
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
}
