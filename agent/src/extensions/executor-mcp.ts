import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../utils/error-message.js";
import { resolveExecutorEndpoint } from "./executor/connection.js";
import { resolveExecutorAuthorizationHeaders } from "./executor/http.js";

export default async function executorMcpExtension(pi: ExtensionAPI): Promise<void> {
  try {
    const endpoint = await resolveExecutorEndpoint();
    const headers = await resolveExecutorAuthorizationHeaders();
    pi.registerMcpServer("executor", { url: endpoint.mcpUrl, headers });
  } catch (error) {
    const warning = `Executor MCP registration failed: ${errorMessage(error)}`;
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    });
  }
  pi.on("session_shutdown", () => {
    pi.unregisterMcpServer("executor");
  });
}
