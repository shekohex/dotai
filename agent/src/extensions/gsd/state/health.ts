import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { resolvePlanningDir } from "../shared.js";
import { readPlanningSnapshot } from "./read.js";

export const HealthOutputSchema = Type.Object(
  {
    healthy: Type.Boolean(),
    issues: Type.Array(
      Type.Object(
        {
          severity: Type.Union([
            Type.Literal("error"),
            Type.Literal("warning"),
            Type.Literal("info"),
          ]),
          file: Type.String(),
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type HealthOutput = Static<typeof HealthOutputSchema>;

export function computeHealth(cwd: string): HealthOutput {
  const issues: HealthOutput["issues"] = [];
  const planningDir = resolvePlanningDir(cwd);
  if (!existsSync(planningDir)) {
    issues.push({ severity: "error", file: ".planning", message: "Missing .planning directory" });
    return { healthy: false, issues };
  }

  const snapshot = readPlanningSnapshot(cwd);
  for (const name of ["config.json", "STATE.md", "ROADMAP.md", "PROJECT.md", "REQUIREMENTS.md"]) {
    if (!existsSync(join(planningDir, name))) {
      issues.push({
        severity: "error",
        file: name,
        message: `Missing ${name}`,
      });
    }
  }

  for (const phase of snapshot.phases) {
    if (phase.plans.length === 0) {
      issues.push({ severity: "warning", file: phase.id, message: "Phase has no plan files" });
    }
    for (const plan of phase.plans) {
      if (!plan.completed) {
        issues.push({
          severity: "info",
          file: `${phase.id}/${plan.fileName}`,
          message: "Plan missing summary",
        });
      }
    }
  }

  return {
    healthy: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}
