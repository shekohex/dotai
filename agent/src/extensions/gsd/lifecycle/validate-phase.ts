import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { GsdCommandArgs } from "../args.js";
import { loadBundledTemplate } from "../resources.js";
import { ensureCurrentPhaseDir, writeStateFields } from "../state/runtime.js";

export function handleGsdValidatePhase(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: GsdCommandArgs,
): void {
  const current = ensureCurrentPhaseDir(ctx.cwd, args.phase);
  mkdirSync(current.phaseDir, { recursive: true });
  const validationPath = join(current.phaseDir, `${current.phaseFilePrefix}-VALIDATION.md`);
  writeFileSync(validationPath, loadBundledTemplate("VALIDATION.md"), "utf8");
  writeStateFields(ctx.cwd, {
    current_phase: current.phase.number,
    current_phase_name: current.phase.name,
    status: "Ready to validate",
  });
  ctx.ui.notify(`Validation template written: ${validationPath}`, "info");
}
