import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { GsdCommandArgs } from "./args.js";
import { resolvePlanningDir } from "./shared.js";
import {
  writePlanCheckReport,
  writePlanFiles,
  writeUatArtifact,
  writeValidationArtifact,
  writeVerificationReport,
} from "./state/reports.js";
import { ensureCurrentPhaseDir, resolveCurrentPhase, writeStateFields } from "./state/runtime.js";
import { spawnPlanner, spawnRole, spawnStructuredRole, type PlanOutput } from "./subagents.js";

export const PlanCheckOutputSchema = Type.Object(
  {
    approved: Type.Boolean(),
    summary: Type.String(),
    coverage: Type.Optional(
      Type.Array(
        Type.Object(
          {
            requirement: Type.String(),
            status: Type.Union([
              Type.Literal("covered"),
              Type.Literal("missing"),
              Type.Literal("partial"),
            ]),
            notes: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    issues: Type.Array(
      Type.Object(
        {
          severity: Type.Union([Type.Literal("blocker"), Type.Literal("warning")]),
          description: Type.String(),
          fix_hint: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type PlanCheckOutput = Static<typeof PlanCheckOutputSchema>;

export const VerificationOutputSchema = Type.Object(
  {
    verified: Type.Boolean(),
    summary: Type.String(),
    truths: Type.Optional(
      Type.Array(
        Type.Object(
          {
            truth: Type.String(),
            status: Type.Union([
              Type.Literal("verified"),
              Type.Literal("failed"),
              Type.Literal("uncertain"),
            ]),
            evidence: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    blockers: Type.Array(Type.String()),
    warnings: Type.Array(Type.String()),
    uat_items: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String(),
            result: Type.Union([
              Type.Literal("pass"),
              Type.Literal("fail"),
              Type.Literal("blocked"),
              Type.Literal("pending"),
            ]),
            reason: Type.Optional(Type.String()),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export type VerificationOutput = Static<typeof VerificationOutputSchema>;

function matchesPlanCheckOutput(value: unknown): value is PlanCheckOutput {
  return Value.Check(PlanCheckOutputSchema, value);
}

function matchesVerificationOutput(value: unknown): value is VerificationOutput {
  return Value.Check(VerificationOutputSchema, value);
}

export type GsdOrchestrationDeps = {
  spawnPlanner: typeof spawnPlanner;
  spawnStructuredRole: typeof spawnStructuredRole;
  spawnRole: typeof spawnRole;
};

const defaultDeps: GsdOrchestrationDeps = {
  spawnPlanner,
  spawnStructuredRole,
  spawnRole,
};

function isOrchestrationDeps(value: unknown): value is GsdOrchestrationDeps {
  return (
    typeof value === "object" &&
    value !== null &&
    "spawnPlanner" in value &&
    "spawnStructuredRole" in value &&
    "spawnRole" in value
  );
}

function buildPlannerTask(cwd: string, current: ReturnType<typeof ensureCurrentPhaseDir>): string {
  const requiredReading = buildRequiredReadingBlock(cwd, [
    "PROJECT.md",
    "REQUIREMENTS.md",
    "ROADMAP.md",
    "STATE.md",
  ]);
  return [
    requiredReading,
    `Current phase: ${current.phase.number} ${current.phase.name}`,
    current.phase.goal !== undefined && current.phase.goal.length > 0
      ? `Goal: ${current.phase.goal}`
      : "",
    current.phase.requirements.length > 0
      ? `Requirements: ${current.phase.requirements.join(", ")}`
      : "",
    current.phase.successCriteria.length > 0
      ? `Success criteria:\n${current.phase.successCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
      : "",
    "Create plan output for current phase. Return plan metadata for one or more plans.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function buildPlanCheckTask(
  cwd: string,
  current: ReturnType<typeof ensureCurrentPhaseDir>,
  planPaths: string[],
): string {
  const requiredReading = buildRequiredReadingBlock(cwd, [
    "PROJECT.md",
    "REQUIREMENTS.md",
    "ROADMAP.md",
    "STATE.md",
    ...planPaths.map((planPath) => relativePlanningPath(cwd, planPath)),
  ]);
  return [
    requiredReading,
    `Review plans for phase ${current.phase.number} ${current.phase.name}.`,
    current.phase.goal !== undefined && current.phase.goal.length > 0
      ? `Goal: ${current.phase.goal}`
      : "",
    current.phase.requirements.length > 0
      ? `Requirements: ${current.phase.requirements.join(", ")}`
      : "",
    `Plan files:\n${planPaths.join("\n")}`,
    "Return whether the plans are approved and include blocker/warning issues.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function buildVerificationTask(
  cwd: string,
  current: NonNullable<ReturnType<typeof resolveCurrentPhase>>,
): string {
  const requiredReading = buildRequiredReadingBlock(cwd, [
    "PROJECT.md",
    "REQUIREMENTS.md",
    "ROADMAP.md",
    "STATE.md",
    relativePlanningPath(cwd, current.phaseDir),
  ]);
  return [
    requiredReading,
    `Verify phase ${current.phase.number} ${current.phase.name}.`,
    current.phase.goal !== undefined && current.phase.goal.length > 0
      ? `Goal: ${current.phase.goal}`
      : "",
    current.phase.requirements.length > 0
      ? `Requirements: ${current.phase.requirements.join(", ")}`
      : "",
    `Phase directory: ${current.phaseDir}`,
    "Return verification status with blockers and warnings.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function buildRequiredReadingBlock(cwd: string, relativePaths: string[]): string {
  const planningDir = resolvePlanningDir(cwd);
  const paths = [...new Set(relativePaths)]
    .map((relativePath) => join(planningDir, relativePath))
    .filter((absolutePath) => existsSync(absolutePath));
  if (paths.length === 0) {
    return "";
  }
  return ["<required_reading>", ...paths, "</required_reading>"].join("\n");
}

function relativePlanningPath(cwd: string, absolutePath: string): string {
  const planningDir = resolvePlanningDir(cwd);
  return absolutePath.startsWith(`${planningDir}/`)
    ? absolutePath.slice(planningDir.length + 1)
    : absolutePath;
}

async function runVerification(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  current: NonNullable<ReturnType<typeof resolveCurrentPhase>>,
  deps: GsdOrchestrationDeps,
): Promise<VerificationOutput> {
  const rawVerification = await deps.spawnStructuredRole(
    pi,
    ctx,
    "verifier",
    buildVerificationTask(ctx.cwd, current),
    VerificationOutputSchema,
    2,
  );
  if (!matchesVerificationOutput(rawVerification)) {
    throw new Error("Verifier output did not match schema");
  }
  const verification = rawVerification;
  writeVerificationReport(current.phaseDir, current.phaseFilePrefix, verification);
  writeValidationArtifact(current.phaseDir, current.phaseFilePrefix, verification);
  writeUatArtifact(current.phaseDir, current.phaseFilePrefix, verification);
  writeStateFields(ctx.cwd, {
    current_phase: current.phase.number,
    current_phase_name: current.phase.name,
    current_plan: "",
    status: verification.verified ? "Phase complete" : "Verification failed",
  });
  if (!verification.verified) {
    throw new Error(
      `Verification failed: ${verification.blockers.length > 0 ? verification.blockers.join(", ") : verification.summary}`,
    );
  }
  return verification;
}

export async function orchestratePlanPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  argsOrDeps: GsdCommandArgs | GsdOrchestrationDeps = {},
  deps = defaultDeps,
): Promise<{ planOutput: PlanOutput; check: PlanCheckOutput; planPaths: string[] }> {
  const args = isOrchestrationDeps(argsOrDeps) ? {} : argsOrDeps;
  const resolvedDeps = isOrchestrationDeps(argsOrDeps) ? argsOrDeps : deps;
  const current = ensureCurrentPhaseDir(ctx.cwd, args.phase);
  const planOutput = await resolvedDeps.spawnPlanner(pi, ctx, buildPlannerTask(ctx.cwd, current));
  const planPaths = writePlanFiles(current.phaseDir, planOutput);
  const rawCheck = await resolvedDeps.spawnStructuredRole(
    pi,
    ctx,
    "plan-checker",
    buildPlanCheckTask(ctx.cwd, current, planPaths),
    PlanCheckOutputSchema,
    2,
  );
  if (!matchesPlanCheckOutput(rawCheck)) {
    throw new Error("Plan checker output did not match schema");
  }
  const check = rawCheck;
  writePlanCheckReport(current.phaseDir, current.phaseFilePrefix, check);
  const firstPlan = planOutput.plans[0];
  writeStateFields(ctx.cwd, {
    current_phase: current.phase.number,
    current_phase_name: current.phase.name,
    current_plan: firstPlan === undefined ? "" : `${firstPlan.phase}-${firstPlan.plan}`,
    status: check.approved ? "Ready to execute" : "Planning blocked",
  });
  if (!check.approved) {
    throw new Error(
      `Plan check failed: ${check.issues.map((issue) => `${issue.severity}:${issue.description}`).join(", ")}`,
    );
  }
  return { planOutput, check, planPaths };
}

export async function orchestrateExecutePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  argsOrDeps: GsdCommandArgs | GsdOrchestrationDeps = {},
  deps = defaultDeps,
): Promise<VerificationOutput> {
  const args = isOrchestrationDeps(argsOrDeps) ? {} : argsOrDeps;
  const resolvedDeps = isOrchestrationDeps(argsOrDeps) ? argsOrDeps : deps;
  const current = resolveCurrentPhase(ctx.cwd, args.phase);
  if (current === undefined) {
    throw new Error("No active phase");
  }
  await resolvedDeps.spawnRole(
    pi,
    ctx,
    "executor",
    `Execute phase ${current.phase.number} ${current.phase.name} using .planning state in ${current.phaseDir}.`,
  );
  return runVerification(pi, ctx, current, resolvedDeps);
}

export function orchestrateVerifyWork(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  argsOrDeps: GsdCommandArgs | GsdOrchestrationDeps = {},
  deps = defaultDeps,
): Promise<VerificationOutput> {
  const args = isOrchestrationDeps(argsOrDeps) ? {} : argsOrDeps;
  const resolvedDeps = isOrchestrationDeps(argsOrDeps) ? argsOrDeps : deps;
  const current = resolveCurrentPhase(ctx.cwd, args.phase);
  if (current === undefined) {
    throw new Error("No active phase");
  }
  return runVerification(pi, ctx, current, resolvedDeps);
}
