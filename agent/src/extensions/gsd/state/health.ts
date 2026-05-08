import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { resolveGsdBundlePath } from "../resources.js";
import { resolvePlanningDir } from "../shared.js";
import { readPlanningSnapshot } from "./read.js";
import { readRoadmapPhases } from "./roadmap.js";

const HealthIssueSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]),
    code: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

const HealthRepairSchema = Type.Object(
  {
    action: Type.String(),
    success: Type.Boolean(),
  },
  { additionalProperties: true },
);

export const HealthOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("healthy"), Type.Literal("degraded"), Type.Literal("broken")]),
    healthy: Type.Boolean(),
    issues: Type.Array(HealthIssueSchema),
    repairableCount: Type.Number(),
    repairsPerformed: Type.Optional(Type.Array(HealthRepairSchema)),
  },
  { additionalProperties: false },
);

export type HealthOutput = Static<typeof HealthOutputSchema>;

export type HealthSummary = Pick<HealthOutput, "status" | "healthy" | "issues">;

const BundledHealthResultSchema = Type.Object(
  {
    status: Type.String(),
    errors: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })),
    warnings: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })),
    info: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })),
    repairable_count: Type.Optional(Type.Number()),
    repairs_performed: Type.Optional(Type.Array(HealthRepairSchema)),
  },
  { additionalProperties: true },
);

const BundledCommandErrorSchema = Type.Object(
  {
    ok: Type.Boolean(),
    message: Type.String(),
  },
  { additionalProperties: true },
);

function runBundledHealthCommand(cwd: string, repair: boolean): HealthOutput {
  const toolPath = resolveGsdBundlePath("bin", "gsd-tools.cjs");
  const args = [toolPath, "validate", "health", "--cwd", cwd, "--json-errors"];
  if (repair) {
    args.push("--repair");
  }

  try {
    const stdout = execFileSync(process.execPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return normalizeBundledHealthResult(stdout);
  } catch (error) {
    return normalizeBundledHealthFailure(error);
  }
}

function normalizeBundledHealthResult(stdout: string): HealthOutput {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Value.Check(BundledHealthResultSchema, parsed)) {
    return malformedHealthResult("Bundled health backend returned invalid JSON shape");
  }

  const issues = [
    ...parsed.errors.map((issue) => ({ severity: "error" as const, ...issue })),
    ...parsed.warnings.map((issue) => ({ severity: "warning" as const, ...issue })),
    ...parsed.info.map((issue) => ({ severity: "info" as const, ...issue })),
  ];
  let status: HealthOutput["status"];
  if (parsed.status === "healthy" || parsed.status === "degraded" || parsed.status === "broken") {
    status = parsed.status;
  } else if (parsed.errors.length > 0) {
    status = "broken";
  } else if (parsed.warnings.length > 0) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  return {
    status,
    healthy: status !== "broken",
    issues,
    repairableCount: parsed.repairable_count ?? 0,
    ...(parsed.repairs_performed === undefined
      ? {}
      : { repairsPerformed: parsed.repairs_performed }),
  };
}

function normalizeBundledHealthFailure(error: unknown): HealthOutput {
  if (!(error instanceof Error)) {
    return malformedHealthResult("Bundled health backend failed");
  }

  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  if (stderr.length > 0) {
    try {
      const parsed = JSON.parse(stderr) as unknown;
      if (Value.Check(BundledCommandErrorSchema, parsed)) {
        return malformedHealthResult(parsed.message);
      }
    } catch {}
  }

  return malformedHealthResult(error.message);
}

function malformedHealthResult(message: string): HealthOutput {
  return {
    status: "broken",
    healthy: false,
    issues: [{ severity: "error", code: "ELOCAL", message }],
    repairableCount: 0,
  };
}

export function computeHealth(cwd: string, options: { repair?: boolean } = {}): HealthOutput {
  return runBundledHealthCommand(cwd, options.repair === true);
}

export function computeLocalHealthSummary(cwd: string): HealthSummary {
  const snapshot = readPlanningSnapshot(cwd);
  const roadmapPhases = readRoadmapPhases(cwd);
  const issues: HealthOutput["issues"] = [];
  const configPath = join(resolvePlanningDir(cwd), "config.json");

  if (snapshot.config === undefined) {
    issues.push({
      severity: existsSync(configPath) ? "error" : "error",
      code: existsSync(configPath) ? "ELOCAL_CONFIG" : "ELOCAL_CONFIG",
      message: existsSync(configPath) ? "config.json malformed" : "config.json not found",
    });
  }
  if (snapshot.state === undefined) {
    issues.push({ severity: "error", code: "ELOCAL_STATE", message: "STATE.md not found" });
  }
  if (snapshot.roadmap === undefined) {
    issues.push({ severity: "error", code: "ELOCAL_ROADMAP", message: "ROADMAP.md not found" });
  }
  if (snapshot.project === undefined) {
    issues.push({ severity: "error", code: "ELOCAL_PROJECT", message: "PROJECT.md not found" });
  }
  if (snapshot.requirements === undefined) {
    issues.push({
      severity: "warning",
      code: "WLOCAL_REQUIREMENTS",
      message: "REQUIREMENTS.md not found",
    });
  }
  if (snapshot.phases.length === 0 && roadmapPhases.length === 0) {
    issues.push({ severity: "warning", code: "WLOCAL_PHASES", message: "No phases found" });
  }

  const phaseCount = Math.max(snapshot.phases.length, roadmapPhases.length);
  if (phaseCount > 0 && snapshot.phases.length === 0) {
    issues.push({
      severity: "warning",
      code: "WLOCAL_PHASE_DIRS",
      message: "Phase artifacts missing",
    });
  }

  for (const phase of snapshot.phases) {
    if (!/^\d{2}(?:\.\d+)?-/u.test(phase.id)) {
      issues.push({
        severity: "warning",
        code: "WLOCAL_PHASE_NAME",
        message: `Phase directory "${phase.id}" doesn't follow NN-name format`,
      });
    }
    for (const plan of phase.plans) {
      if (!plan.completed) {
        issues.push({
          severity: "info",
          code: "ILOCAL_SUMMARY",
          message: `${phase.id}/${plan.fileName} has no SUMMARY.md`,
        });
      }
    }
  }

  let status: HealthSummary["status"] = "healthy";
  if (issues.some((issue) => issue.severity === "error")) {
    status = "broken";
  } else if (issues.length > 0) {
    status = "degraded";
  }

  return {
    status,
    healthy: status !== "broken",
    issues,
  };
}
