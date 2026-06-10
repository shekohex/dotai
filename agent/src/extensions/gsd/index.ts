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

const GSD_FLAG = "gsd";

function isGsdEnabled(pi: ExtensionAPI, cwd: string): boolean {
  return pi.getFlag(GSD_FLAG) === true || getGsdSettings(cwd).enabled;
}

export default function gsdExtension(pi: ExtensionAPI): void {
  pi.registerFlag(GSD_FLAG, {
    description: "Enable GSD extension behavior for this session",
    type: "boolean",
    default: false,
  });
  syncBuiltInGsdModes(true);
  registerGsdMessageRenderers(pi);
  pi.on("session_start", async (event, ctx) => {
    rememberGsdCwd(ctx.cwd);
    syncBuiltInGsdModes(true);
    if (!isGsdEnabled(pi, ctx.cwd)) {
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
    let systemPrompt: string | undefined;
    if (isGsdEnabled(pi, ctx.cwd)) {
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
