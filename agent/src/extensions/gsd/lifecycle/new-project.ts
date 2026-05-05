import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ensurePlanningDir } from "../state/write.js";
import { loadBundledTemplate } from "../resources.js";
import { writeStateFields } from "../state/runtime.js";

export function handleGsdNewProject(_pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const planningDir = ensurePlanningDir(ctx.cwd);
  const projectName = basename(ctx.cwd) || "Project";
  writeFileSync(
    join(planningDir, "config.json"),
    `${JSON.stringify(
      {
        model_profile: "balanced",
        commit_docs: true,
        parallelization: true,
        search_gitignored: false,
        brave_search: false,
        firecrawl: false,
        exa_search: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(planningDir, "PROJECT.md"),
    loadBundledTemplate("project.md").replaceAll("[Project Name]", projectName),
    "utf8",
  );
  writeFileSync(
    join(planningDir, "REQUIREMENTS.md"),
    loadBundledTemplate("requirements.md").replaceAll("[Project Name]", projectName),
    "utf8",
  );
  writeFileSync(
    join(planningDir, "ROADMAP.md"),
    loadBundledTemplate("roadmap-empty.md").replaceAll("[Project Name]", projectName),
    "utf8",
  );
  writeFileSync(join(planningDir, "STATE.md"), loadBundledTemplate("state.md"), "utf8");
  writeStateFields(ctx.cwd, {
    current_phase: "1",
    current_phase_name: "Phase 1",
    current_plan: "",
    status: "Ready to plan",
  });
  ctx.ui.notify(`GSD initialized in ${planningDir}`, "info");
}
