import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRunningInCoderWorkspace } from "../../utils/browser-access.js";
import {
  cleanGlanceStorage,
  ensureGlanceDaemon,
  probeGlance,
  readGlanceStatus,
  startGlanceHeartbeat,
  stopGlanceDaemon,
  waitForGlanceStopped,
  type GlanceHeartbeatHandle,
} from "./daemon.js";
import { getGlancePaths } from "./paths.js";

const GLANCE_COMMAND_ACTIONS = [
  { value: "status", description: "Show daemon status, upload URL, and storage path" },
  { value: "start", description: "Start heartbeat and daemon" },
  { value: "stop", description: "Stop heartbeat and daemon" },
  { value: "restart", description: "Stop then start daemon" },
  { value: "clean", description: "Remove stored uploads locally" },
] as const;

interface GlanceCommandContext {
  cwd: string;
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
}

function joinGlanceUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBaseUrl).toString();
}

export default function (pi: ExtensionAPI) {
  let heartbeat: GlanceHeartbeatHandle | null = null;
  const paths = getGlancePaths();
  let signalHandlersRegistered = false;

  const stopHeartbeat = (): void => {
    void heartbeat?.stop();
    heartbeat = null;
  };

  const unregisterSignalHandlers = (): void => {
    if (!signalHandlersRegistered) {
      return;
    }
    process.off("SIGTERM", stopHeartbeat);
    process.off("SIGINT", stopHeartbeat);
    if (process.platform !== "win32") {
      process.off("SIGHUP", stopHeartbeat);
    }
    signalHandlersRegistered = false;
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!isRunningInCoderWorkspace()) {
      return;
    }

    try {
      heartbeat = await startGlanceHeartbeat({ paths, cwd: ctx.cwd });
      await ensureGlanceDaemon({ paths });
    } catch (error) {
      await heartbeat?.stop();
      heartbeat = null;
      const message = error instanceof Error ? error.message : "Glance failed to start";
      ctx.ui.notify(`Glance unavailable: ${message}`, "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    unregisterSignalHandlers();
    await heartbeat?.stop();
    heartbeat = null;
  });

  if (!signalHandlersRegistered) {
    process.on("SIGTERM", stopHeartbeat);
    process.on("SIGINT", stopHeartbeat);
    if (process.platform !== "win32") {
      process.on("SIGHUP", stopHeartbeat);
    }
    signalHandlersRegistered = true;
  }

  const handler = async (args: string, ctx: GlanceCommandContext) => {
    const action = args.trim() || "status";
    if (action === "start") {
      heartbeat ??= await startGlanceHeartbeat({ paths, cwd: ctx.cwd });
      const status = await ensureGlanceDaemon({ paths });
      const baseUrl = status.publicBaseUrl ?? status.baseUrl;
      ctx.ui.notify(
        `Glance started\nUpload: ${joinGlanceUrl(baseUrl, "upload")}\nStorage: ${status.storageDir}`,
        "info",
      );
      return;
    }

    if (action === "stop") {
      await heartbeat?.stop();
      heartbeat = null;
      const result = await stopGlanceDaemon(paths);
      ctx.ui.notify(`Glance stop: ${result}`, "info");
      return;
    }

    if (action === "restart") {
      await stopGlanceDaemon(paths);
      if (!(await waitForGlanceStopped(paths))) {
        ctx.ui.notify("Glance restart failed: previous daemon did not stop", "warning");
        return;
      }
      heartbeat ??= await startGlanceHeartbeat({ paths, cwd: ctx.cwd });
      const status = await ensureGlanceDaemon({ paths });
      const baseUrl = status.publicBaseUrl ?? status.baseUrl;
      ctx.ui.notify(
        `Glance restarted\nUpload: ${joinGlanceUrl(baseUrl, "upload")}\nStorage: ${status.storageDir}`,
        "info",
      );
      return;
    }

    if (action === "clean") {
      const deleted = await cleanGlanceStorage(paths);
      ctx.ui.notify(`Glance cleaned ${deleted} files`, "info");
      return;
    }

    if (action !== "status") {
      ctx.ui.notify("Usage: /glance <status|restart|start|stop|clean>", "warning");
      return;
    }

    const status = await readGlanceStatus(paths);
    if (status === null) {
      ctx.ui.notify("Glance status: stopped", "info");
      return;
    }
    const healthy = await probeGlance(status);
    const baseUrl = status.publicBaseUrl ?? status.baseUrl;
    ctx.ui.notify(
      `Glance status: ${healthy ? "running" : "unhealthy"}\nUpload: ${joinGlanceUrl(baseUrl, "upload")}\nStorage: ${status.storageDir}`,
      healthy ? "info" : "warning",
    );
  };

  const getArgumentCompletions = (prefix: string) => {
    const normalizedPrefix = prefix.trim().toLowerCase();
    const items = GLANCE_COMMAND_ACTIONS.filter((action) =>
      action.value.startsWith(normalizedPrefix),
    ).map((action) => ({
      value: action.value,
      label: action.value,
      description: action.description,
    }));
    return items.length > 0 ? items : null;
  };

  pi.registerCommand("glance", {
    description: "Manage Glance image upload daemon",
    handler,
    getArgumentCompletions,
  });
}
