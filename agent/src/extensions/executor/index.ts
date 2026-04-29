import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import { isAuthoritativeRuntime } from "../runtime-authority.js";
import { registerExecutorCommands } from "./commands.js";
import { getExecutorSettings } from "./settings.js";
import {
  applyExecutorUpdatedEvent,
  clearExecutorState,
  connectExecutor,
  EXECUTOR_UPDATED_EVENT,
  hydrateExecutorState,
  readHydratedExecutorState,
} from "./status.js";
import { isExecutorToolDetails, loadExecutorPrompt, registerExecutorTools } from "./tools.js";

export default function (pi: ExtensionAPI): void {
  pi.events.on?.(EXECUTOR_UPDATED_EVENT, (data) => {
    applyExecutorUpdatedEvent(data);
  });

  pi.on("session_start", async (_event, ctx) => {
    await registerExecutorTools(pi, ctx.cwd, ctx.hasUI);

    if (!isAuthoritativeRuntime(ctx)) {
      const hydratedState = readHydratedExecutorState(ctx.sessionManager);
      if (hydratedState) {
        hydrateExecutorState(ctx.cwd, hydratedState);
      } else {
        clearExecutorState(pi, ctx.cwd);
      }
      return;
    }

    const settings = getExecutorSettings();

    if (settings.autoStart) {
      try {
        await connectExecutor(pi, ctx);
      } catch (error) {
        const message = errorMessage(error);
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
    if (!isAuthoritativeRuntime(ctx)) {
      return;
    }

    clearExecutorState(pi, ctx.cwd);
  });
}
