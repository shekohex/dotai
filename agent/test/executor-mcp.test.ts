import { createServer } from "node:http";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

import { setExecutorSettingsForTests } from "../src/extensions/executor/settings.js";
import { piMcpAdapterExtensionFactory } from "../src/extensions/pi-mcp-adapter.js";
import { createTestSession, type TestSession } from "./support/pi-test-harness/index.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, readStoredCredential: vi.fn(actual.readStoredCredential) };
});

afterEach(() => {
  setExecutorSettingsForTests(undefined);
  vi.restoreAllMocks();
});

test("bundled MCP adapter registers the first available Executor endpoint", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/api/integrations") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }

    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected Executor test server address");
  }

  let session: TestSession | undefined;
  try {
    setExecutorSettingsForTests({
      autoStart: true,
      probeTimeoutMs: 200,
      candidates: [
        { label: "unavailable", mcpUrl: "http://127.0.0.1:1/mcp" },
        { label: "available", mcpUrl: `http://127.0.0.1:${address.port}/mcp` },
      ],
    });

    session = await createTestSession({
      extensionFactories: [piMcpAdapterExtensionFactory],
    });
    const mcpTool = (session.session.agent.state.tools as AgentTool[]).find(
      (tool) => tool.name === "mcp",
    );
    if (mcpTool === undefined) {
      throw new Error("Expected bundled MCP tool");
    }

    const result = await mcpTool.execute(
      "executor-status",
      {},
      new AbortController().signal,
      undefined,
    );
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    expect(text).toContain("executor");
    expect(text).toContain("not connected");
  } finally {
    session?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("Executor runtime registration injects the stored bearer credential", async () => {
  vi.mocked(codingAgent.readStoredCredential).mockReturnValue({
    type: "api_key",
    key: "executor-secret",
  });
  const mcpAuthorizationHeaders: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/api/integrations") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    if (request.url === "/mcp") {
      mcpAuthorizationHeaders.push(request.headers.authorization ?? "");
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
      }
      const requestId = /"id":("[^"]+"|\d+)/u.exec(body)?.[1];
      const protocolVersion = /"protocolVersion":"([^"]+)"/u.exec(body)?.[1];

      if (body.includes('"method":"initialize"') && requestId && protocolVersion) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          `{"jsonrpc":"2.0","id":${requestId},"result":{"protocolVersion":"${protocolVersion}","capabilities":{"tools":{}},"serverInfo":{"name":"executor-test","version":"1.0.0"}}}`,
        );
        return;
      }
      if (body.includes('"method":"tools/list"') && requestId) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`{"jsonrpc":"2.0","id":${requestId},"result":{"tools":[]}}`);
        return;
      }

      response.writeHead(202);
      response.end();
      return;
    }

    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected Executor test server address");
  }

  let session: TestSession | undefined;
  try {
    setExecutorSettingsForTests({
      autoStart: true,
      probeTimeoutMs: 200,
      candidates: [{ label: "available", mcpUrl: `http://127.0.0.1:${address.port}/mcp` }],
    });

    session = await createTestSession({
      extensionFactories: [piMcpAdapterExtensionFactory],
    });
    const mcpTool = (session.session.agent.state.tools as AgentTool[]).find(
      (tool) => tool.name === "mcp",
    );
    if (mcpTool === undefined) {
      throw new Error("Expected bundled MCP tool");
    }

    await mcpTool.execute(
      "executor-connect",
      { connect: "executor" },
      new AbortController().signal,
      undefined,
    );

    expect(mcpAuthorizationHeaders.length).toBeGreaterThan(0);
    expect(new Set(mcpAuthorizationHeaders)).toEqual(new Set(["Bearer executor-secret"]));
  } finally {
    session?.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
