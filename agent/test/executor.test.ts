import { expect, afterEach, test } from "vitest";
import { createServer } from "node:http";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import createExecutorExtension from "../src/extensions/executor/index.ts";
import { getExecutorState } from "../src/extensions/executor/status.ts";
import {
  getExecutorWebUrl,
  setExecutorSettingsForTests,
} from "../src/extensions/executor/settings.ts";
import { resolveExecutorEndpoint } from "../src/extensions/executor/connection.ts";
import { clearExecutorInspectionCache } from "../src/extensions/executor/tools.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

afterEach(() => {
  setExecutorSettingsForTests(undefined);
  clearExecutorInspectionCache();
});

class FakePi implements Partial<ExtensionAPI> {
  readonly registeredTools = new Map<string, ToolDefinition<any, any>>();
  readonly registerToolCalls: string[] = [];
  readonly handlers = new Map<string, Array<(...args: any[]) => any>>();
  readonly events = {
    emit: () => {},
  };

  registerTool(tool: ToolDefinition<any, any>): void {
    this.registeredTools.set(tool.name, tool);
    this.registerToolCalls.push(tool.name);
  }

  registerCommand(): void {}

  on(eventName: string, handler: (...args: any[]) => any): void {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }
}

async function emitHandlers(
  fakePi: FakePi,
  eventName: string,
  event: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  for (const handler of fakePi.handlers.get(eventName) ?? []) {
    await handler(event, ctx);
  }
}

function createFakeContext(): ExtensionContext {
  return {
    cwd: "/tmp/executor-session-restart",
    hasUI: false,
    ui: {
      notify: () => {},
    },
  } as unknown as ExtensionContext;
}

async function createExecutorProbeServer(
  scopeDir: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/api/scope") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "scope_test", name: "executor-test", dir: scopeDir }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

timedTest("getExecutorWebUrl strips the /mcp suffix", () => {
  expect(getExecutorWebUrl("http://127.0.0.1:4788/mcp")).toBe("http://127.0.0.1:4788/");
  expect(getExecutorWebUrl("http://127.0.0.1:4788/mcp/")).toBe("http://127.0.0.1:4788/");
});

timedTest("resolveExecutorEndpoint falls back to the next healthy candidate", async () => {
  const server = await createExecutorProbeServer("/tmp/executor-scope");

  try {
    setExecutorSettingsForTests({
      autoStart: true,
      probeTimeoutMs: 200,
      candidates: [
        { label: "offline", mcpUrl: "http://127.0.0.1:1/mcp" },
        { label: "online", mcpUrl: server.url },
      ],
    });

    const endpoint = await resolveExecutorEndpoint();

    expect(endpoint.label).toBe("online");
    expect(endpoint.mcpUrl).toBe(server.url);
    expect(endpoint.webUrl).toBe(server.url.replace(/\/mcp$/, "/"));
    expect(endpoint.scope.id).toBe("scope_test");
    expect(endpoint.scope.dir).toBe("/tmp/executor-scope");
  } finally {
    await server.close();
  }
});

timedTest("executor tools re-register after session restart with same cwd", async () => {
  setExecutorSettingsForTests({
    autoStart: false,
    probeTimeoutMs: 10,
    candidates: [{ label: "offline", mcpUrl: "http://127.0.0.1:1/mcp" }],
  });

  const fakePi = new FakePi();
  const ctx = createFakeContext();

  createExecutorExtension(fakePi as ExtensionAPI);

  await emitHandlers(fakePi, "session_start", { reason: "startup" }, ctx);

  expect(fakePi.registerToolCalls).toEqual(["execute", "resume"]);
  expect(fakePi.registeredTools.has("execute")).toBeTruthy();
  expect(fakePi.registeredTools.has("resume")).toBeTruthy();

  fakePi.registeredTools.clear();

  await emitHandlers(fakePi, "session_shutdown", { reason: "new" }, ctx);
  await emitHandlers(fakePi, "session_start", { reason: "new" }, ctx);

  expect(fakePi.registerToolCalls).toEqual(["execute", "resume", "execute", "resume"]);
  expect(fakePi.registeredTools.has("execute")).toBeTruthy();
  expect(fakePi.registeredTools.has("resume")).toBeTruthy();
});
