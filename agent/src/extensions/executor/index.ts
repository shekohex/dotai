import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerExecutorCommands } from "./commands.js";
import { getExecutorSettings } from "./settings.js";
import { clearExecutorState, connectExecutor } from "./status.js";
import { isExecutorToolDetails, loadExecutorPrompt, registerExecutorTools } from "./tools.js";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await registerExecutorTools(pi, ctx.cwd, ctx.hasUI);

    const settings = getExecutorSettings();

    if (settings.autoStart) {
      try {
        await connectExecutor(pi, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Executor auto-start failed: ${message}`, "warning");
      }
    } else {
      clearExecutorState(pi, ctx.cwd);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => ({
    systemPrompt: `${event.systemPrompt}\n\n${await loadExecutorPrompt(ctx.cwd, ctx.hasUI)}`,
  }));

  pi.on("tool_result", (event) => {
    if (
      (event.toolName === "execute" || event.toolName === "resume") &&
      typeof event.details === "object" &&
      event.details !== null &&
      isExecutorToolDetails(event.details)
    ) {
      return { isError: event.details.isError };
    }

    return {};
  });

  registerExecutorCommands(pi);

  pi.on("session_shutdown", (_event, ctx) => {
    clearExecutorState(pi, ctx.cwd);
  });
}
