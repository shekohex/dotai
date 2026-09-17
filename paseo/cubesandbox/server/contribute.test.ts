import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contributeServer } from "./contribute.js";

const executeFile = promisify(execFile);

afterEach(() => vi.unstubAllEnvs());

describe("CubeSandbox server contribution", () => {
  it("injects init tool for a Git repo whose default branch is unresolved", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "cube-hook-test-"));
    const repositoryRoot = path.join(fixture, "project");
    const remote = path.join(fixture, "empty.git");
    const stateDirectory = path.join(fixture, "state");
    await executeFile("git", ["init", "--bare", remote]);
    await executeFile("git", [
      "init",
      "-b",
      "feature/unresolved-default",
      repositoryRoot,
    ]);
    await executeFile("git", [
      "-C",
      repositoryRoot,
      "remote",
      "add",
      "origin",
      remote,
    ]);
    vi.stubEnv("CUBESANDBOX_PASEO_STATE_DIR", stateDirectory);

    let agentCreateHook:
      | ((input: {
          request: {
            config: {
              cwd: string;
              mcpServers?: Record<string, unknown>;
            };
          };
        }) => Promise<unknown>)
      | undefined;
    const server = {
      before: vi.fn((name: string, handler: typeof agentCreateHook) => {
        if (name === "agent.create") agentCreateHook = handler;
        return vi.fn();
      }),
      handle: vi.fn(),
    } as unknown as PluginServerContext;
    const cleanup = contributeServer(server);
    expect(agentCreateHook).toBeDefined();

    const transformed = (await agentCreateHook!({
      request: { config: { cwd: repositoryRoot, mcpServers: {} } },
    })) as {
      config: {
        mcpServers: { cubesandbox: { type: string; url: string } };
      };
    };
    const capability = transformed.config.mcpServers.cubesandbox;
    expect(capability.type).toBe("http");

    const client = new Client({ name: "init-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(capability.url),
    );
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "cube_init_config",
      );
      const result = await client.callTool({
        name: "cube_init_config",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        "Cannot determine origin default branch",
      );
      await expect(stat(path.join(repositoryRoot, ".cube"))).rejects.toThrow();
    } finally {
      await client.close();
      await cleanup?.();
    }
  });
});
