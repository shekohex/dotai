import { createServer } from "node:http";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

import { setExecutorSettingsForTests } from "../src/extensions/executor/settings.js";
import executorMcpExtension from "../src/extensions/executor-mcp.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, readStoredCredential: vi.fn(actual.readStoredCredential) };
});

afterEach(() => {
  setExecutorSettingsForTests(undefined);
  vi.restoreAllMocks();
});

async function startExecutorApi() {
  const server = createServer((request, response) => {
    response.writeHead(request.url === "/api/integrations" ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end("[]");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected Executor test server address");
  }
  return {
    mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

test("Executor bridge registers the first available endpoint and unregisters on shutdown", async () => {
  const executor = await startExecutorApi();
  const registerMcpServer = vi.fn();
  const unregisterMcpServer = vi.fn();
  let shutdown: (() => void) | undefined;
  try {
    setExecutorSettingsForTests({
      autoStart: true,
      probeTimeoutMs: 200,
      candidates: [
        { label: "unavailable", mcpUrl: "http://127.0.0.1:1/mcp" },
        { label: "available", mcpUrl: executor.mcpUrl },
      ],
    });
    await executorMcpExtension({
      registerMcpServer,
      unregisterMcpServer,
      on: (event: string, handler: () => void) => {
        if (event === "session_shutdown") shutdown = handler;
      },
    } as unknown as ExtensionAPI);
    expect(registerMcpServer).toHaveBeenCalledWith(
      "executor",
      expect.objectContaining({ url: executor.mcpUrl }),
    );
    expect(shutdown).toBeDefined();
    shutdown?.();
    expect(unregisterMcpServer).toHaveBeenCalledWith("executor");
  } finally {
    await executor.close();
  }
});

test("Executor bridge registration injects the stored bearer credential", async () => {
  vi.mocked(codingAgent.readStoredCredential).mockReturnValue({
    type: "api_key",
    key: "executor-secret",
  });
  const executor = await startExecutorApi();
  const registerMcpServer = vi.fn();
  try {
    setExecutorSettingsForTests({
      autoStart: true,
      probeTimeoutMs: 200,
      candidates: [{ label: "available", mcpUrl: executor.mcpUrl }],
    });
    await executorMcpExtension({ registerMcpServer, on: vi.fn() } as unknown as ExtensionAPI);
    expect(registerMcpServer).toHaveBeenCalledWith("executor", {
      url: executor.mcpUrl,
      headers: { Authorization: "Bearer executor-secret" },
    });
  } finally {
    await executor.close();
  }
});
