import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../utils/error-message.js";
import {
  createToolStateEntry,
  readToolState,
  TOOL_STATE_ENTRY_TYPE,
} from "../../utils/tool-state.js";
import { registerExecutorCommands } from "./commands.js";
import { getExecutorSettings } from "./settings.js";
import { clearExecutorState, connectExecutor } from "./status.js";
import { isExecutorToolDetails, loadExecutorPrompt, registerExecutorTools } from "./tools.js";

const EXECUTOR_TOOL_STATE_KEY = "executor";
const EXECUTOR_TOOL_NAMES = ["execute", "resume"];

function activateExecutorTools(pi: ExtensionAPI): void {
  const activeTools = new Set([...pi.getActiveTools(), ...EXECUTOR_TOOL_NAMES]);
  pi.setActiveTools(Array.from(activeTools).toSorted((left, right) => left.localeCompare(right)));
}

function deactivateExecutorTools(pi: ExtensionAPI): void {
  pi.setActiveTools(
    pi.getActiveTools().filter((toolName) => !EXECUTOR_TOOL_NAMES.includes(toolName)),
  );
}

export default function (pi: ExtensionAPI): void {
  let toolsRegistered = false;
  let toolEnabled = false;

  const ensureToolsRegistered = async (ctx: ExtensionContext): Promise<void> => {
    if (toolsRegistered) {
      return;
    }

    await registerExecutorTools(pi, ctx.cwd, ctx.hasUI);
    toolsRegistered = true;
  };

  const persistToolState = (): void => {
    pi.appendEntry(
      TOOL_STATE_ENTRY_TYPE,
      createToolStateEntry(EXECUTOR_TOOL_STATE_KEY, toolEnabled),
    );
  };

  const enableTool = async (ctx: ExtensionContext): Promise<void> => {
    await ensureToolsRegistered(ctx);
    toolEnabled = true;
    activateExecutorTools(pi);
  };

  const disableTool = (ctx: Pick<ExtensionContext, "cwd">): void => {
    toolEnabled = false;
    deactivateExecutorTools(pi);
    clearExecutorState(pi, ctx.cwd);
  };

  const restoreToolState = async (ctx: ExtensionContext): Promise<void> => {
    const restored = readToolState(ctx.sessionManager.getBranch(), EXECUTOR_TOOL_STATE_KEY);
    if (restored === true) {
      await enableTool(ctx);
      return;
    }

    disableTool(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    await restoreToolState(ctx);

    const settings = getExecutorSettings();

    if (toolEnabled && settings.autoStart) {
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

  pi.on("session_tree", async (_event, ctx) => {
    await restoreToolState(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!toolEnabled) {
      deactivateExecutorTools(pi);
      return {};
    }

    await ensureToolsRegistered(ctx);
    activateExecutorTools(pi);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${await loadExecutorPrompt(ctx.cwd, ctx.hasUI)}`,
    };
  });

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

  registerExecutorCommands(pi, {
    isEnabled: () => toolEnabled,
    enable: async (ctx: ExtensionCommandContext) => {
      await enableTool(ctx);
      persistToolState();
    },
    disable: (ctx: ExtensionCommandContext) => {
      disableTool(ctx);
      persistToolState();
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    toolsRegistered = false;
    clearExecutorState(pi, ctx.cwd);
  });
}
