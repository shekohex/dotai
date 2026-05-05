import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildGsdSystemContext } from "./context.js";
import { registerGsdCommands } from "./commands.js";
import { registerBuiltInGsdModes } from "./modes.js";
import { getGsdSettings } from "./settings.js";
import { rememberGsdCwd } from "./state/cwd.js";
import { detectExistingPlanning } from "./state/detect.js";
import { registerGsdMessageRenderers } from "./ui/messages.js";

export default function gsdExtension(pi: ExtensionAPI): void {
  registerBuiltInGsdModes();
  registerGsdMessageRenderers(pi);
  pi.on("session_start", (_event, ctx) => {
    rememberGsdCwd(ctx.cwd);
    const settings = getGsdSettings(ctx.cwd);
    if (!settings.enabled) {
      return;
    }
    const existing = detectExistingPlanning(ctx.cwd);
    if (existing.valid) {
      ctx.ui.notify(
        `GSD continuing ${existing.projectName ?? "project"} (${existing.phaseCount} phases)`,
        "info",
      );
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    rememberGsdCwd(ctx.cwd);
    const settings = getGsdSettings(ctx.cwd);
    let systemPrompt: string | undefined;
    if (settings.enabled) {
      const planningContext = buildGsdSystemContext(ctx.cwd);
      if (planningContext.length > 0) {
        systemPrompt = `${event.systemPrompt}\n\n${planningContext}`;
      }
    }
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });

  registerGsdCommands(pi);
}
