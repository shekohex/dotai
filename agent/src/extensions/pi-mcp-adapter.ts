import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

import { errorMessage } from "../utils/error-message.js";
import { resolveExecutorEndpoint } from "./executor/connection.js";
import { resolveExecutorAuthorizationHeaders } from "./executor/http.js";

interface McpServerRegistration {
  dispose(): Promise<void>;
}

export interface PiMcpAdapterModuleContract {
  default: ExtensionFactory;
  registerMcpServer(options: {
    pi: ExtensionAPI;
    name: string;
    definition: {
      url: string;
      headers?: Record<string, string>;
    };
  }): McpServerRegistration;
}

const jiti = createJiti(import.meta.url);
const piMcpAdapter = await jiti.import<PiMcpAdapterModuleContract>("pi-mcp-adapter");

export const piMcpAdapterExtensionFactory: ExtensionFactory = async (pi) => {
  await piMcpAdapter.default(pi);

  // pi-mcp-adapter scopes registerMcpServer() by exact ExtensionAPI identity, while Pi
  // creates a different ExtensionAPI object for every extension factory. Keep Executor
  // registration in this factory so it uses the same object that installed the adapter.
  // A separate Executor extension fails with "pi-mcp-adapter is not installed for this
  // Pi instance" until the adapter scopes runtime registration to shared Pi runtime state.
  let executorRegistration: McpServerRegistration | undefined;

  pi.on("session_start", async (_event, ctx) => {
    await executorRegistration?.dispose();
    executorRegistration = undefined;

    try {
      const endpoint = await resolveExecutorEndpoint();
      const headers = await resolveExecutorAuthorizationHeaders();
      executorRegistration = piMcpAdapter.registerMcpServer({
        pi,
        name: "executor",
        definition: {
          url: endpoint.mcpUrl,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
      });
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Executor MCP registration failed: ${errorMessage(error)}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    await executorRegistration?.dispose();
    executorRegistration = undefined;
  });
};
