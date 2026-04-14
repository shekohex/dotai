import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getExecutorWebUrl, setExecutorSettingsForTests } from "../src/extensions/executor/settings.ts";
import { resolveExecutorEndpoint } from "../src/extensions/executor/connection.ts";
import { formatExecutorStatus } from "../src/extensions/coreui/footer.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) => test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

test.afterEach(() => {
  setExecutorSettingsForTests(undefined);
});

async function createExecutorProbeServer(scopeDir: string): Promise<{ url: string; close: () => Promise<void> }> {
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
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

timedTest("getExecutorWebUrl strips the /mcp suffix", () => {
  assert.equal(getExecutorWebUrl("http://127.0.0.1:4788/mcp"), "http://127.0.0.1:4788/");
  assert.equal(getExecutorWebUrl("http://127.0.0.1:4788/mcp/"), "http://127.0.0.1:4788/");
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

    assert.equal(endpoint.label, "online");
    assert.equal(endpoint.mcpUrl, server.url);
    assert.equal(endpoint.webUrl, server.url.replace(/\/mcp$/, "/"));
    assert.equal(endpoint.scope.id, "scope_test");
    assert.equal(endpoint.scope.dir, "/tmp/executor-scope");
  } finally {
    await server.close();
  }
});

timedTest("formatExecutorStatus only renders when executor is connected", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
  };

  assert.equal(formatExecutorStatus(theme as never, { kind: "idle" }), undefined);
  assert.equal(formatExecutorStatus(theme as never, { kind: "connecting" }), undefined);
  assert.equal(formatExecutorStatus(theme as never, { kind: "error", message: "boom" }), undefined);
  assert.equal(
    formatExecutorStatus(theme as never, {
      kind: "ready",
      label: "lan",
      mcpUrl: "http://127.0.0.1:4788/mcp",
      webUrl: "http://127.0.0.1:4788/",
      scopeId: "scope_test",
      scopeDir: "/tmp/executor-scope",
    }),
    "executor",
  );
});
