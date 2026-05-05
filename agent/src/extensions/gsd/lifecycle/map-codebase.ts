import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { resolvePlanningDir } from "../shared.js";
import { spawnStructuredRole } from "../subagents.js";
import { ensurePlanningDir } from "../state/write.js";

const CodebaseMapOutputSchema = Type.Object(
  {
    summary: Type.String(),
    modules: Type.Array(
      Type.Object(
        {
          name: Type.String(),
          purpose: Type.String(),
          files: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    tests: Type.Array(Type.String()),
    conventions: Type.Array(Type.String()),
    risks: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

type CodebaseMapOutput = Static<typeof CodebaseMapOutputSchema>;

function matchesCodebaseMapOutput(value: unknown): value is CodebaseMapOutput {
  return Value.Check(CodebaseMapOutputSchema, value);
}

export async function handleGsdMapCodebase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ensurePlanningDir(ctx.cwd);
  const outputPath = join(resolvePlanningDir(ctx.cwd), "research", "CODEBASE_MAP.md");
  const rawOutput = await spawnStructuredRole(
    pi,
    ctx,
    "codebase-mapper",
    [
      "<required_reading>",
      join(resolvePlanningDir(ctx.cwd), "PROJECT.md"),
      join(resolvePlanningDir(ctx.cwd), "REQUIREMENTS.md"),
      join(resolvePlanningDir(ctx.cwd), "ROADMAP.md"),
      join(resolvePlanningDir(ctx.cwd), "STATE.md"),
      "</required_reading>",
      "",
      `Read repo and return a structured codebase map. Persisted artifact path: ${outputPath}.`,
    ].join("\n"),
    CodebaseMapOutputSchema,
    2,
  );
  if (!matchesCodebaseMapOutput(rawOutput)) {
    throw new Error("Codebase mapper output did not match schema");
  }
  const output = rawOutput;
  writeFileSync(
    outputPath,
    [
      "# Codebase Map",
      "",
      "## Summary",
      "",
      output.summary,
      "",
      "## Modules",
      "",
      ...(output.modules.length === 0
        ? ["- None"]
        : output.modules.flatMap((module) => [
            `### ${module.name}`,
            "",
            module.purpose,
            "",
            `Files: ${module.files.join(", ")}`,
            "",
          ])),
      "## Tests",
      "",
      ...(output.tests.length === 0 ? ["- None"] : output.tests.map((item) => `- ${item}`)),
      "",
      "## Conventions",
      "",
      ...(output.conventions.length === 0
        ? ["- None"]
        : output.conventions.map((item) => `- ${item}`)),
      "",
      "## Risks",
      "",
      ...(output.risks.length === 0 ? ["- None"] : output.risks.map((item) => `- ${item}`)),
      "",
    ].join("\n"),
    "utf8",
  );
  ctx.ui.notify(`Codebase map updated: ${outputPath}`, "info");
}
