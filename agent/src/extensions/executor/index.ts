import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerExecutorCommands } from "./commands.js";
import { getExecutorSettings } from "./settings.js";
import { clearExecutorState, connectExecutor } from "./status.js";
import { isExecutorToolDetails, loadExecutorPrompt, registerExecutorTools } from "./tools.js";

const registeredToolSets = new Set<string>();

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const key = `${ctx.cwd}:${ctx.hasUI ? "ui" : "headless"}`;
    if (!registeredToolSets.has(key)) {
      await registerExecutorTools(pi, ctx.cwd, ctx.hasUI);
      registeredToolSets.add(key);
    }

    const settings = getExecutorSettings();

    if (!settings.autoStart) {
      clearExecutorState(pi, ctx.cwd);
      return;
    }

    try {
      await connectExecutor(pi, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Executor auto-start failed: ${message}`, "warning");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => ({
    systemPrompt: `${event.systemPrompt}\n\n${await loadExecutorPrompt(ctx.cwd, ctx.hasUI)}`,
  }));

  pi.on("tool_result", async (event) => {
    if (
      (event.toolName === "execute" || event.toolName === "resume") &&
      typeof event.details === "object" &&
      event.details !== null &&
      isExecutorToolDetails(event.details)
    ) {
      return { isError: event.details.isError };
    }
  });

  registerExecutorCommands(pi);

  pi.on("session_shutdown", async (_event, ctx) => {
    clearExecutorState(pi, ctx.cwd);
  });
}
