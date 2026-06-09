import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGsdSystemContext } from "./context.js";
import { registerGsdCommands } from "./commands.js";
import { syncBuiltInGsdModes } from "./modes.js";
import { getGsdSettings } from "./settings.js";
import { rememberGsdCwd } from "./state/cwd.js";
import { detectExistingPlanning } from "./state/detect.js";
import { disposeGsdSubagentSdkForSession } from "./subagents.js";
import { registerGsdMessageRenderers } from "./ui/messages.js";
import { applyPendingGsdWorkflowLaunch } from "./workflow-launch.js";

export default function gsdExtension(pi: ExtensionAPI): void {
  registerGsdMessageRenderers(pi);
  pi.on("session_start", async (event, ctx) => {
    rememberGsdCwd(ctx.cwd);
    const settings = getGsdSettings(ctx.cwd);
    syncBuiltInGsdModes(settings.enabled);
    if (!settings.enabled) {
      return;
    }
    await applyPendingGsdWorkflowLaunch(pi, ctx, event.reason);
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

  pi.on("session_shutdown", (_event, ctx) => {
    disposeGsdSubagentSdkForSession(ctx);
  });

  registerGsdCommands(pi);
}
