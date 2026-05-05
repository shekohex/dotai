import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { fillTemplate, loadBundledTemplate } from "../resources.js";
import { resolvePlanningDir } from "../shared.js";
import { spawnStructuredRole } from "../subagents.js";
import { ensureCurrentPhaseDir, writeStateFields } from "../state/runtime.js";

const DiscussPhaseOutputSchema = Type.Object(
  {
    boundary: Type.String(),
    decisions: Type.Array(
      Type.Object(
        {
          area: Type.String(),
          choices: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    discretion: Type.Array(Type.String()),
    specifics: Type.Array(Type.String()),
    references: Type.Array(
      Type.Object(
        {
          path: Type.String(),
          reason: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
    reusable_assets: Type.Array(Type.String()),
    patterns: Type.Array(Type.String()),
    integration_points: Type.Array(Type.String()),
    deferred: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

type DiscussPhaseOutput = Static<typeof DiscussPhaseOutputSchema>;

function matchesDiscussPhaseOutput(value: unknown): value is DiscussPhaseOutput {
  return Value.Check(DiscussPhaseOutputSchema, value);
}

export function handleGsdDiscussPhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): Promise<void> {
  const current = ensureCurrentPhaseDir(ctx.cwd, args.phase);
  mkdirSync(current.phaseDir, { recursive: true });
  const contextPath = join(current.phaseDir, `${current.phaseFilePrefix}-CONTEXT.md`);
  return spawnStructuredRole(
    pi,
    ctx,
    "phase-researcher",
    [
      "<required_reading>",
      join(resolvePlanningDir(ctx.cwd), "PROJECT.md"),
      join(resolvePlanningDir(ctx.cwd), "REQUIREMENTS.md"),
      join(resolvePlanningDir(ctx.cwd), "ROADMAP.md"),
      join(resolvePlanningDir(ctx.cwd), "STATE.md"),
      "</required_reading>",
      "",
      `Discuss and structure context for phase ${current.phase.number} ${current.phase.name}. Persisted artifact path: ${contextPath}.`,
    ].join("\n"),
    DiscussPhaseOutputSchema,
    2,
  ).then((rawOutput) => {
    if (!matchesDiscussPhaseOutput(rawOutput)) {
      throw new Error("Discuss phase output did not match schema");
    }
    const output = rawOutput;
    writeFileSync(
      contextPath,
      [
        fillTemplate(loadBundledTemplate("context.md"), {
          X: current.phase.number,
          Name: current.phase.name,
          date: new Date().toISOString().slice(0, 10),
        }),
        "",
        "## Phase Boundary",
        "",
        output.boundary,
        "",
        "## Implementation Decisions",
        "",
        ...(output.decisions.length === 0
          ? ["No structured decisions captured.", ""]
          : output.decisions.flatMap((decision) => [
              `### ${decision.area}`,
              "",
              ...decision.choices.map(
                (choice, index) => `- **D-${String(index + 1).padStart(2, "0")}:** ${choice}`,
              ),
              "",
            ])),
        "## Claude's Discretion",
        "",
        ...(output.discretion.length === 0
          ? ["None", ""]
          : [...output.discretion.map((item) => `- ${item}`), ""]),
        "## Specific Ideas",
        "",
        ...(output.specifics.length === 0
          ? ["None", ""]
          : [...output.specifics.map((item) => `- ${item}`), ""]),
        "## Canonical References",
        "",
        ...(output.references.length === 0
          ? ["None", ""]
          : output.references.flatMap((reference) => [
              `- \`${reference.path}\` - ${reference.reason}`,
              "",
            ])),
        "## Existing Code Insights",
        "",
        "### Reusable Assets",
        "",
        ...(output.reusable_assets.length === 0
          ? ["- None"]
          : output.reusable_assets.map((item) => `- ${item}`)),
        "",
        "### Established Patterns",
        "",
        ...(output.patterns.length === 0 ? ["- None"] : output.patterns.map((item) => `- ${item}`)),
        "",
        "### Integration Points",
        "",
        ...(output.integration_points.length === 0
          ? ["- None"]
          : output.integration_points.map((item) => `- ${item}`)),
        "",
        "## Deferred Ideas",
        "",
        ...(output.deferred.length === 0
          ? ["None", ""]
          : [...output.deferred.map((item) => `- ${item}`), ""]),
      ].join("\n"),
      "utf8",
    );
    writeStateFields(ctx.cwd, {
      current_phase: current.phase.number,
      current_phase_name: current.phase.name,
      status: "Ready to plan",
    });
    ctx.ui.notify(`Phase context ready: ${contextPath}`, "info");
  });
}
