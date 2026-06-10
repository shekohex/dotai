import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../../utils/error-message.js";
import { resolvePlanningDir } from "../shared.js";
import { parsePlanMarkdownContent, readPlanningConfig } from "./read.js";
import { readRoadmapPhases, type RoadmapPhase } from "./roadmap.js";
import type { PlanFrontmatter } from "./schema.js";
import { ensureCurrentPhaseDir, resolveCurrentPhase, writeStateFields } from "./runtime.js";

const PlanMustHavesObjectSchema = Type.Object(
  {
    truths: Type.Optional(Type.Array(Type.String())),
    artifacts: Type.Optional(Type.Array(Type.Unknown())),
    key_links: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
);

const PlanCheckerResultSchema = Type.Object(
  {
    approved: Type.Boolean(),
    summary: Type.String(),
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

export type PlanCheckerResult = Static<typeof PlanCheckerResultSchema>;

export type ValidatedPlanArtifact = {
  path: string;
  fileName: string;
  frontmatter: PlanFrontmatter;
  body: string;
};

export type PlanPhaseRoute = "standard" | "research" | "gaps" | "reviews";

export type PlanPhaseArtifacts = {
  route: PlanPhaseRoute;
  current: ReturnType<typeof ensureCurrentPhaseDir>;
  phaseGoal?: string;
  phaseRequirementIds: string[];
  contextPath?: string;
  researchPath?: string;
  patternsPath?: string;
  validationPath?: string;
  verificationPath?: string;
  uatPath?: string;
  reviewsPath?: string;
  uiSpecPath?: string;
};

type ResolvePlanPhaseArtifactsInput = {
  cwd: string;
  route: PlanPhaseRoute;
  requestedPhase?: string;
  current?: ReturnType<typeof ensureCurrentPhaseDir>;
};

const planShapePattern = /PLAN/i;
const planOutlinePattern = /-PLAN-OUTLINE\.md$/i;
const planPreBouncePattern = /-PLAN.*\.pre-bounce\.md$/i;
const planCheckPattern = /-PLAN-CHECK\.md$/i;

function looksLikePlanFile(fileName: string): boolean {
  return (
    /\.md$/i.test(fileName) &&
    planShapePattern.test(fileName) &&
    !planOutlinePattern.test(fileName) &&
    !planPreBouncePattern.test(fileName) &&
    !planCheckPattern.test(fileName)
  );
}

function matchesCanonicalPlanFile(fileName: string, phasePrefix: string): boolean {
  const escaped = phasePrefix.replaceAll(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`^${escaped}-\\d{2}-PLAN\\.md$`, "u").test(fileName);
}

function normalizePlanValue(value: string | number): string {
  return String(value).padStart(2, "0");
}

function normalizePhaseValue(value: string | number): string {
  const text = String(value);
  const leadingPhase = text.match(/^(\d+(?:\.\d+)?)/u)?.[1] ?? text;
  if (/^\d+$/u.test(leadingPhase)) {
    return leadingPhase.padStart(2, "0");
  }
  return leadingPhase;
}

export function normalizeExplicitPhaseToken(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (/^0+\d+$/u.test(normalized)) {
    return String(Number.parseInt(normalized, 10));
  }
  return normalized;
}

function extractTaskCount(body: string): number {
  const taskHeadingCount = [...body.matchAll(/^###+\s+Task\s+\d+:/gmu)].length;
  if (taskHeadingCount > 0) {
    return taskHeadingCount;
  }
  const xmlTaskCount = [...body.matchAll(/<task\b/giu)].length;
  if (xmlTaskCount > 0) {
    return xmlTaskCount;
  }
  return [...body.matchAll(/^-\s+\[[ x]\]\s+/gmu)].length;
}

function hasTaskSection(body: string): boolean {
  return body.includes("## Tasks") || body.includes("<tasks>");
}

export function validateCanonicalPlanArtifacts(
  phaseDir: string,
  phasePrefix: string,
): ValidatedPlanArtifact[] {
  if (!existsSync(phaseDir)) {
    throw new Error(`Phase directory missing: ${phaseDir}`);
  }

  const entries = readdirSync(phaseDir).filter((entry) => entry.endsWith(".md"));
  const planShapedFiles = entries.filter((entry) => looksLikePlanFile(entry));
  const canonicalFiles = planShapedFiles.filter((entry) =>
    matchesCanonicalPlanFile(entry, phasePrefix),
  );
  const nonCanonicalFiles = planShapedFiles.filter(
    (entry) => !matchesCanonicalPlanFile(entry, phasePrefix),
  );

  if (nonCanonicalFiles.length > 0) {
    throw new Error(
      `Found non-canonical plan files: ${nonCanonicalFiles.join(", ")}. Expected ${phasePrefix}-{NN}-PLAN.md.`,
    );
  }

  if (canonicalFiles.length === 0) {
    throw new Error(`No canonical plan files found for phase ${phasePrefix}.`);
  }

  return canonicalFiles
    .toSorted((left, right) => left.localeCompare(right))
    .map((fileName) => {
      const path = join(phaseDir, fileName);
      const parsed = parsePlanMarkdownContent(fileName, readFileSync(path, "utf8"));
      const planSuffix = fileName.slice(phasePrefix.length + 1, phasePrefix.length + 3);
      const frontmatterPhase = normalizePhaseValue(parsed.frontmatter.phase);
      const frontmatterPlan = normalizePlanValue(parsed.frontmatter.plan);
      if (frontmatterPhase !== phasePrefix) {
        throw new Error(
          `Plan file ${fileName} has mismatched frontmatter phase ${frontmatterPhase}.`,
        );
      }
      if (frontmatterPlan !== planSuffix) {
        throw new Error(
          `Plan file ${fileName} has mismatched frontmatter plan ${frontmatterPlan}.`,
        );
      }
      const taskCount = extractTaskCount(parsed.body);
      if (!hasTaskSection(parsed.body) || taskCount === 0) {
        throw new Error(`Plan file ${fileName} missing required task structure.`);
      }
      const mustHaves = parsed.frontmatter.must_haves;
      let hasMustHaves = false;
      if (Array.isArray(mustHaves)) {
        hasMustHaves = mustHaves.length > 0;
      } else if (typeof mustHaves === "string") {
        hasMustHaves = mustHaves.trim().length > 0;
      } else if (Value.Check(PlanMustHavesObjectSchema, mustHaves)) {
        const truths = Array.isArray(mustHaves.truths) ? mustHaves.truths : [];
        const artifacts = Array.isArray(mustHaves.artifacts) ? mustHaves.artifacts : [];
        const keyLinks = Array.isArray(mustHaves.key_links) ? mustHaves.key_links : [];
        hasMustHaves = truths.length > 0 || artifacts.length > 0 || keyLinks.length > 0;
      }
      if (!hasMustHaves) {
        throw new Error(`Plan file ${fileName} missing must_haves.`);
      }
      return {
        path,
        fileName,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      } satisfies ValidatedPlanArtifact;
    });
}

export function resolveResearchArtifactPath(phaseDir: string, phasePrefix: string): string {
  return join(phaseDir, `${phasePrefix}-RESEARCH.md`);
}

export function resolvePatternsArtifactPath(phaseDir: string, phasePrefix: string): string {
  return join(phaseDir, `${phasePrefix}-PATTERNS.md`);
}

function resolveOptionalArtifactPath(
  phaseDir: string,
  phasePrefix: string,
  suffix: string,
): string | undefined {
  const path = join(phaseDir, `${phasePrefix}-${suffix}.md`);
  return existsSync(path) ? path : undefined;
}

export function hasResearchArtifact(phaseDir: string, phasePrefix: string): boolean {
  return existsSync(resolveResearchArtifactPath(phaseDir, phasePrefix));
}

export function writePlanCheckReport(
  phaseDir: string,
  phasePrefix: string,
  result: PlanCheckerResult,
  iteration: number,
): string {
  const path = join(phaseDir, `${phasePrefix}-PLAN-CHECK.md`);
  writeFileSync(
    path,
    [
      "---",
      `phase: ${phasePrefix}`,
      `approved: ${String(result.approved)}`,
      `iteration: ${String(iteration)}`,
      "---",
      "",
      `# Plan Check ${phasePrefix}`,
      "",
      "## Summary",
      "",
      result.summary,
      "",
      "## Issues",
      "",
      ...(result.issues.length === 0
        ? ["None"]
        : result.issues.map(
            (issue) =>
              `- ${issue.severity.toUpperCase()}: ${issue.description}${issue.fix_hint === undefined ? "" : ` (${issue.fix_hint})`}`,
          )),
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

export function finalizePlanPhaseArtifacts(input: {
  cwd: string;
  phase: RoadmapPhase;
  phasePrefix: string;
  validPlans: ValidatedPlanArtifact[];
}): void {
  const firstPlan = input.validPlans[0];
  const currentPlan =
    firstPlan === undefined
      ? ""
      : `${input.phasePrefix}-${normalizePlanValue(firstPlan.frontmatter.plan)}`;
  writeStateFields(input.cwd, {
    current_phase: input.phase.number,
    current_phase_name: input.phase.name,
    current_plan: currentPlan,
    status: "Ready to execute",
  });
  updateRoadmapPlanCount(input.cwd, input.phase, input.validPlans.length);
}

export function markPlanPhaseFailure(input: {
  cwd: string;
  phase: RoadmapPhase;
  status: string;
}): void {
  writeStateFields(input.cwd, {
    current_phase: input.phase.number,
    current_phase_name: input.phase.name,
    current_plan: "",
    status: input.status,
  });
}

function updateRoadmapPlanCount(cwd: string, phase: RoadmapPhase, planCount: number): void {
  const roadmapPath = join(resolvePlanningDir(cwd), "ROADMAP.md");
  if (!existsSync(roadmapPath)) {
    return;
  }
  const content = readFileSync(roadmapPath, "utf8");
  const escapedPhase = phase.number.replaceAll(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const updated = content.replace(
    new RegExp(
      `(#{3,4}\\s+Phase\\s+${escapedPhase}:.*?[\\s\\S]*?\\*\\*Plans\\*\\*:\\s*)[^\\n]+`,
      "u",
    ),
    `$1${planCount} plan${planCount === 1 ? "" : "s"}`,
  );
  writeFileSync(roadmapPath, updated, "utf8");
}

export function shouldRunResearch(cwd: string): boolean {
  const config = readPlanningConfig(cwd);
  return config?.workflow?.research !== false;
}

export function resolveRoadmapPhase(cwd: string, phaseNumber: string | undefined): RoadmapPhase {
  const phases = readRoadmapPhases(cwd);
  const normalizedPhaseNumber = normalizeExplicitPhaseToken(phaseNumber);
  if (normalizedPhaseNumber === undefined) {
    return resolveOmittedPlanPhase(cwd);
  }
  const phase = phases.find((entry) => entry.number === normalizedPhaseNumber);
  if (phase === undefined) {
    throw new Error(`Phase ${normalizedPhaseNumber} not found in ROADMAP.md.`);
  }
  return phase;
}

export function resolveOmittedPlanPhase(cwd: string): RoadmapPhase {
  const phases = readRoadmapPhases(cwd);
  const nextUnplannedPhase = phases.find(
    (phase) => phase.plans.length === 0 || phase.plans.some((plan) => !plan.completed),
  );
  if (nextUnplannedPhase !== undefined) {
    return nextUnplannedPhase;
  }
  const current = resolveCurrentPhase(cwd);
  if (current !== undefined) {
    return current.phase;
  }
  throw new Error("ROADMAP.md has no phase definitions");
}

export function matchesPlanCheckerResult(value: unknown): value is PlanCheckerResult {
  return Value.Check(PlanCheckerResultSchema, value);
}

export function resolvePlanPhaseRoute(args: {
  researchPhase?: string;
  gaps?: boolean;
  reviews?: boolean;
}): PlanPhaseRoute {
  if (args.researchPhase !== undefined) {
    return "research";
  }
  if (args.gaps === true) {
    return "gaps";
  }
  if (args.reviews === true) {
    return "reviews";
  }
  return "standard";
}

export function validatePlanPhaseRouteArgs(args: {
  researchPhase?: string;
  gaps?: boolean;
  reviews?: boolean;
}): string | undefined {
  const activeRoutes = [
    args.researchPhase === undefined ? undefined : "--research-phase",
    args.gaps === true ? "--gaps" : undefined,
    args.reviews === true ? "--reviews" : undefined,
  ].filter((route): route is string => route !== undefined);
  if (activeRoutes.length <= 1) {
    return undefined;
  }
  return `Unsupported /gsd plan-phase route combination: ${activeRoutes.join(" + ")}. Choose exactly one route.`;
}

export function resolvePlanPhaseArtifacts(
  input: ResolvePlanPhaseArtifactsInput,
): PlanPhaseArtifacts {
  const current =
    input.current ??
    ensureCurrentPhaseDir(input.cwd, normalizeExplicitPhaseToken(input.requestedPhase));
  const { phaseDir, phaseFilePrefix, phase } = current;
  return {
    route: input.route,
    current,
    phaseGoal: phase.goal,
    phaseRequirementIds: phase.requirements,
    contextPath: resolveOptionalArtifactPath(phaseDir, phaseFilePrefix, "CONTEXT"),
    researchPath: resolveOptionalArtifactPath(phaseDir, phaseFilePrefix, "RESEARCH"),
    patternsPath: resolveOptionalArtifactPath(phaseDir, phaseFilePrefix, "PATTERNS"),
    validationPath: resolveOptionalArtifactPath(phaseDir, phaseFilePrefix, "VALIDATION"),
    verificationPath: resolveOptionalArtifactPath(phaseDir, phaseFilePrefix, "VERIFICATION"),
    uatPath: resolveOptionalArtifactPath(phaseDir, phaseFilePrefix, "UAT"),
    reviewsPath: resolveOptionalArtifactPath(phaseDir, phaseFilePrefix, "REVIEWS"),
    uiSpecPath: resolveOptionalArtifactPath(phaseDir, phaseFilePrefix, "UI-SPEC"),
  };
}

export function assertPlanPhaseRouteArtifacts(artifacts: PlanPhaseArtifacts): void {
  if (artifacts.route === "gaps") {
    if (artifacts.verificationPath !== undefined || artifacts.uatPath !== undefined) {
      return;
    }
    throw new Error(
      `Gap planning requires verification evidence. Missing ${artifacts.current.phaseFilePrefix}-VERIFICATION.md or ${artifacts.current.phaseFilePrefix}-UAT.md.`,
    );
  } else if (artifacts.route === "reviews" && artifacts.reviewsPath === undefined) {
    throw new Error(
      `Review planning requires ${artifacts.current.phaseFilePrefix}-REVIEWS.md for phase ${artifacts.current.phase.number}.`,
    );
  }
}

export function runPlanPhaseSuccessHelpers(input: {
  cwd: string;
  phase: RoadmapPhase;
  phaseDir: string;
}): string[] {
  const toolPath = join(input.cwd, "src", "resources", "gsd", "bin", "gsd-tools.cjs");
  const bundledToolPath = join(process.cwd(), "src", "resources", "gsd", "bin", "gsd-tools.cjs");
  const resolvedToolPath = existsSync(toolPath) ? toolPath : bundledToolPath;
  const warnings: string[] = [];
  const helpers = [
    {
      name: "annotate-dependencies",
      args: [resolvedToolPath, "roadmap", "annotate-dependencies", input.phase.number],
    },
    {
      name: "gap-analysis",
      args: [resolvedToolPath, "gap-analysis", "--phase-dir", input.phaseDir],
    },
  ];

  for (const helper of helpers) {
    try {
      execFileSync(process.execPath, helper.args, {
        cwd: input.cwd,
        stdio: "pipe",
      });
    } catch (error) {
      const message = errorMessage(error);
      warnings.push(`Plan helper failed (${helper.name}); continuing: ${message}`);
    }
  }

  return warnings;
}

export { PlanCheckerResultSchema };
