import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { spawnRole, spawnStructuredRole } from "../subagents.js";
import {
  assertPlanPhaseRouteArtifacts,
  finalizePlanPhaseArtifacts,
  hasResearchArtifact,
  markPlanPhaseFailure,
  matchesPlanCheckerResult,
  type PlanPhaseArtifacts,
  PlanCheckerResultSchema,
  normalizeExplicitPhaseToken,
  resolvePlanPhaseArtifacts,
  resolvePlanPhaseRoute,
  resolveRoadmapPhase,
  runPlanPhaseSuccessHelpers,
  shouldRunResearch,
  validatePlanPhaseRouteArgs,
  validateCanonicalPlanArtifacts,
  writePlanCheckReport,
} from "../state/plan-phase.js";
import { ensureCurrentPhaseDir } from "../state/runtime.js";

const PlannerStatusSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("created"), Type.Literal("revised")]),
    summary: Type.String(),
  },
  { additionalProperties: false },
);

function buildRequiredReading(paths: string[]): string {
  const existing = paths.filter((path) => existsSync(path));
  if (existing.length === 0) {
    return "";
  }
  return ["<required_reading>", ...existing, "</required_reading>"].join("\n");
}

function buildPhaseContextBlock(artifacts: PlanPhaseArtifacts): string {
  const lines = [
    `<phase_goal>${artifacts.phaseGoal ?? ""}</phase_goal>`,
    `<phase_requirement_ids>${artifacts.phaseRequirementIds.join(", ")}</phase_requirement_ids>`,
  ];
  return lines.join("\n");
}

function unsupportedPlanPhaseError(args: GsdCommandArgs): string | undefined {
  if (args.unsupportedModeError !== undefined) {
    return args.unsupportedModeError;
  }
  const routeError = validatePlanPhaseRouteArgs(args);
  if (routeError !== undefined) {
    return routeError;
  }
  if (args.view === true && args.researchPhase === undefined) {
    return "Unsupported /gsd plan-phase flag combination: --view only works with --research-phase in Slice 1.";
  }
  return undefined;
}

type ResearchArtifactAction = "view" | "regenerate" | "skip";

async function chooseResearchArtifactAction(
  ctx: ExtensionCommandContext,
  researchPath: string,
): Promise<ResearchArtifactAction | undefined> {
  if (typeof ctx.ui.select !== "function") {
    ctx.ui.notify(
      `Research artifact already exists: ${researchPath}. Choose next step: rerun with --view, --research, or remove artifact to regenerate later.`,
      "warning",
    );
    return undefined;
  }
  const selection = await ctx.ui.select("Research artifact exists", [
    "View existing research",
    "Regenerate research",
    "Skip",
  ]);
  if (selection === "View existing research") {
    return "view";
  }
  if (selection === "Regenerate research") {
    return "regenerate";
  }
  if (selection === "Skip") {
    return "skip";
  }
  return undefined;
}

function buildResearchTask(cwd: string, artifacts: PlanPhaseArtifacts): string {
  const { current } = artifacts;
  return [
    buildRequiredReading([
      join(cwd, ".planning", "PROJECT.md"),
      join(cwd, ".planning", "REQUIREMENTS.md"),
      join(cwd, ".planning", "ROADMAP.md"),
      join(cwd, ".planning", "STATE.md"),
      ...(artifacts.contextPath === undefined ? [] : [artifacts.contextPath]),
      ...(artifacts.validationPath === undefined ? [] : [artifacts.validationPath]),
      ...(artifacts.uiSpecPath === undefined ? [] : [artifacts.uiSpecPath]),
    ]),
    buildPhaseContextBlock(artifacts),
    `Research phase ${current.phase.number} ${current.phase.name}.`,
    `Write canonical research artifact to ${join(current.phaseDir, `${current.phaseFilePrefix}-RESEARCH.md`)}.`,
    "Return after file is written.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function buildPatternTask(cwd: string, artifacts: PlanPhaseArtifacts): string {
  const { current } = artifacts;
  return [
    buildRequiredReading([
      join(cwd, ".planning", "PROJECT.md"),
      join(cwd, ".planning", "REQUIREMENTS.md"),
      join(cwd, ".planning", "ROADMAP.md"),
      join(cwd, ".planning", "STATE.md"),
      ...(artifacts.contextPath === undefined ? [] : [artifacts.contextPath]),
      ...(artifacts.researchPath === undefined ? [] : [artifacts.researchPath]),
      ...(artifacts.validationPath === undefined ? [] : [artifacts.validationPath]),
      ...(artifacts.uiSpecPath === undefined ? [] : [artifacts.uiSpecPath]),
    ]),
    buildPhaseContextBlock(artifacts),
    `Map implementation patterns for phase ${current.phase.number} ${current.phase.name}.`,
    `Write canonical pattern artifact to ${join(current.phaseDir, `${current.phaseFilePrefix}-PATTERNS.md`)} if useful.`,
    "Return after pattern analysis is complete.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function buildPlannerTask(
  cwd: string,
  artifacts: PlanPhaseArtifacts,
  revisionIssues?: string[],
): string {
  const { current } = artifacts;
  let routeContext = "Route: standard.";
  if (artifacts.route === "gaps") {
    routeContext = "Route: gaps. Replan only to close documented verification or UAT gaps.";
  } else if (artifacts.route === "reviews") {
    routeContext = "Route: reviews. Replan from reviews feedback in REVIEWS.md.";
  }
  return [
    buildRequiredReading([
      join(cwd, ".planning", "PROJECT.md"),
      join(cwd, ".planning", "REQUIREMENTS.md"),
      join(cwd, ".planning", "ROADMAP.md"),
      join(cwd, ".planning", "STATE.md"),
      ...(artifacts.contextPath === undefined ? [] : [artifacts.contextPath]),
      ...(artifacts.researchPath === undefined ? [] : [artifacts.researchPath]),
      ...(artifacts.patternsPath === undefined ? [] : [artifacts.patternsPath]),
      ...(artifacts.validationPath === undefined ? [] : [artifacts.validationPath]),
      ...(artifacts.verificationPath === undefined ? [] : [artifacts.verificationPath]),
      ...(artifacts.uatPath === undefined ? [] : [artifacts.uatPath]),
      ...(artifacts.reviewsPath === undefined ? [] : [artifacts.reviewsPath]),
      ...(artifacts.uiSpecPath === undefined ? [] : [artifacts.uiSpecPath]),
    ]),
    buildPhaseContextBlock(artifacts),
    routeContext,
    `Plan phase ${current.phase.number} ${current.phase.name}.`,
    `Canonical plan files must be written under ${current.phaseDir} using ${current.phaseFilePrefix}-{NN}-PLAN.md.`,
    revisionIssues === undefined || revisionIssues.length === 0
      ? "Write at least one canonical PLAN artifact and then return status."
      : `Revise existing plan artifacts to resolve checker issues:\n${revisionIssues.map((issue, index) => `${index + 1}. ${issue}`).join("\n")}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function buildCheckerTask(cwd: string, artifacts: PlanPhaseArtifacts, planPaths: string[]): string {
  const { current } = artifacts;
  return [
    buildRequiredReading([
      join(cwd, ".planning", "PROJECT.md"),
      join(cwd, ".planning", "REQUIREMENTS.md"),
      join(cwd, ".planning", "ROADMAP.md"),
      join(cwd, ".planning", "STATE.md"),
      ...(artifacts.contextPath === undefined ? [] : [artifacts.contextPath]),
      ...(artifacts.researchPath === undefined ? [] : [artifacts.researchPath]),
      ...(artifacts.patternsPath === undefined ? [] : [artifacts.patternsPath]),
      ...(artifacts.validationPath === undefined ? [] : [artifacts.validationPath]),
      ...(artifacts.verificationPath === undefined ? [] : [artifacts.verificationPath]),
      ...(artifacts.uatPath === undefined ? [] : [artifacts.uatPath]),
      ...(artifacts.reviewsPath === undefined ? [] : [artifacts.reviewsPath]),
      ...(artifacts.uiSpecPath === undefined ? [] : [artifacts.uiSpecPath]),
      ...planPaths,
    ]),
    buildPhaseContextBlock(artifacts),
    `Check canonical plans for phase ${current.phase.number} ${current.phase.name}.`,
    "Read plan files from disk. Return pass/fail with issues.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

async function runPlanner(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  artifacts: PlanPhaseArtifacts,
  revisionIssues?: string[],
): Promise<void> {
  await spawnStructuredRole(
    pi,
    ctx,
    "planner",
    buildPlannerTask(ctx.cwd, artifacts, revisionIssues),
    PlannerStatusSchema,
    2,
  );
}

class PlanPhaseBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanPhaseBlockedError";
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveArtifactPath(
  current: PlanPhaseArtifacts["current"],
  suffix: "RESEARCH" | "PATTERNS",
): string {
  return join(current.phaseDir, `${current.phaseFilePrefix}-${suffix}.md`);
}

function withLatestGeneratedArtifacts(artifacts: PlanPhaseArtifacts): PlanPhaseArtifacts {
  const researchPath = resolveArtifactPath(artifacts.current, "RESEARCH");
  const patternsPath = resolveArtifactPath(artifacts.current, "PATTERNS");
  return {
    ...artifacts,
    researchPath: existsSync(researchPath) ? researchPath : artifacts.researchPath,
    patternsPath: existsSync(patternsPath) ? patternsPath : artifacts.patternsPath,
  };
}

async function maybeRunPatternMapper(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  artifacts: PlanPhaseArtifacts,
): Promise<void> {
  try {
    await spawnRole(
      pi,
      ctx,
      "pattern-mapper",
      buildPatternTask(ctx.cwd, withLatestGeneratedArtifacts(artifacts)),
    );
  } catch (error) {
    const message = formatErrorMessage(error);
    ctx.ui.notify(`Pattern mapping failed; continuing without PATTERNS.md: ${message}`, "warning");
  }
}

function finalizeSuccessfulPlanPhase(input: {
  cwd: string;
  phase: ReturnType<typeof resolveRoadmapPhase>;
  current: PlanPhaseArtifacts["current"];
  validPlans: ReturnType<typeof validateCanonicalPlanArtifacts>;
}): void {
  runPlanPhaseSuccessHelpers({
    cwd: input.cwd,
    phase: input.phase,
    phaseDir: input.current.phaseDir,
  });
  finalizePlanPhaseArtifacts({
    cwd: input.cwd,
    phase: input.phase,
    phasePrefix: input.current.phaseFilePrefix,
    validPlans: input.validPlans,
  });
}

export async function handleGsdPlanPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  const unsupported = unsupportedPlanPhaseError(args);
  if (unsupported !== undefined) {
    ctx.ui.notify(unsupported, "warning");
    return;
  }

  const requestedPhase = normalizeExplicitPhaseToken(args.researchPhase ?? args.phase);
  const route = resolvePlanPhaseRoute(args);
  const phase = resolveRoadmapPhase(ctx.cwd, requestedPhase);
  const current = ensureCurrentPhaseDir(ctx.cwd, phase.number);
  const artifacts = resolvePlanPhaseArtifacts({ cwd: ctx.cwd, route, current });
  assertPlanPhaseRouteArtifacts(artifacts);

  if (args.researchPhase !== undefined) {
    const researchPath = join(current.phaseDir, `${current.phaseFilePrefix}-RESEARCH.md`);
    const researchExists = existsSync(researchPath);
    if (args.view === true) {
      if (!researchExists) {
        throw new Error(`Research artifact missing for --view: ${researchPath}`);
      }
      ctx.ui.notify(readFileSync(researchPath, "utf8"), "info");
      return;
    }
    if (researchExists && args.research !== true) {
      const action = await chooseResearchArtifactAction(ctx, researchPath);
      if (action === "view") {
        ctx.ui.notify(readFileSync(researchPath, "utf8"), "info");
        return;
      }
      if (action === "regenerate") {
        await spawnRole(pi, ctx, "phase-researcher", buildResearchTask(ctx.cwd, artifacts));
        ctx.ui.notify(`Research artifact ready: ${researchPath}`, "info");
        return;
      }
      if (action !== "skip") {
        return;
      }
      return;
    }
    await spawnRole(pi, ctx, "phase-researcher", buildResearchTask(ctx.cwd, artifacts));
    ctx.ui.notify(`Research artifact ready: ${researchPath}`, "info");
    return;
  }

  const shouldReuseResearch = hasResearchArtifact(current.phaseDir, current.phaseFilePrefix);
  let runResearch = false;
  if (route === "gaps" || route === "reviews") {
    runResearch = false;
  } else if (args.skipResearch === true) {
    runResearch = false;
  } else if (args.research === true) {
    runResearch = true;
  } else if (shouldReuseResearch) {
    runResearch = false;
  } else {
    runResearch = shouldRunResearch(ctx.cwd);
  }

  try {
    if (runResearch) {
      await spawnRole(pi, ctx, "phase-researcher", buildResearchTask(ctx.cwd, artifacts));
    }

    await maybeRunPatternMapper(pi, ctx, artifacts);

    let validatedPlans = [];
    let latestIssues: string[] | undefined;

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      const currentArtifacts = withLatestGeneratedArtifacts(artifacts);
      await runPlanner(pi, ctx, currentArtifacts, latestIssues);
      validatedPlans = validateCanonicalPlanArtifacts(current.phaseDir, current.phaseFilePrefix);
      if (args.skipVerify === true) {
        finalizeSuccessfulPlanPhase({ cwd: ctx.cwd, phase, current, validPlans: validatedPlans });
        ctx.ui.notify(`Planned ${validatedPlans.length} plan(s); verification skipped`, "info");
        return;
      }
      const rawResult = await spawnStructuredRole(
        pi,
        ctx,
        "plan-checker",
        buildCheckerTask(
          ctx.cwd,
          currentArtifacts,
          validatedPlans.map((plan) => plan.path),
        ),
        PlanCheckerResultSchema,
        2,
      );
      if (!matchesPlanCheckerResult(rawResult)) {
        throw new Error("Plan checker output did not match schema");
      }
      writePlanCheckReport(current.phaseDir, current.phaseFilePrefix, rawResult, iteration);
      if (rawResult.approved) {
        finalizeSuccessfulPlanPhase({ cwd: ctx.cwd, phase, current, validPlans: validatedPlans });
        ctx.ui.notify(`Planned ${validatedPlans.length} plan(s); check approved`, "info");
        return;
      }
      latestIssues = rawResult.issues.map((issue) => `${issue.severity}: ${issue.description}`);
    }

    markPlanPhaseFailure({ cwd: ctx.cwd, phase, status: "Planning blocked" });
    throw new PlanPhaseBlockedError("Plan checker failed after 3 attempts.");
  } catch (error) {
    if (!(error instanceof PlanPhaseBlockedError)) {
      markPlanPhaseFailure({ cwd: ctx.cwd, phase, status: "Planning failed" });
    }
    throw error;
  }
}
