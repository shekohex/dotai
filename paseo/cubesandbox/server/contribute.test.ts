import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { PaseoApi, PaseoProject, PaseoWorkspace } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contributeServer } from "./contribute.js";
import { CUBE_CONFIG_SCHEMA_URL } from "../shared/config.js";

const executeFile = promisify(execFile);

afterEach(() => vi.unstubAllEnvs());

describe("CubeSandbox server contribution", () => {
  it("resolves nested agent capabilities to the canonical Git-root config", async () => {
    const repositoryRoot = await mkdtemp(
      path.join(os.tmpdir(), "cube-hook-repository-"),
    );
    const nestedProjectRoot = path.join(repositoryRoot, "agent");
    const stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cube-hook-state-"),
    );
    await executeFile("git", ["init", "-b", "main", repositoryRoot]);
    await executeFile("git", [
      "-C",
      repositoryRoot,
      "remote",
      "add",
      "origin",
      "git@github.com:acme/widget.git",
    ]);
    await executeFile("git", [
      "-C",
      repositoryRoot,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    await mkdir(path.join(repositoryRoot, ".cube"));
    await mkdir(nestedProjectRoot);
    await writeFile(
      path.join(repositoryRoot, ".cube", "config.json"),
      JSON.stringify({
        $schema: CUBE_CONFIG_SCHEMA_URL,
        version: 1,
        project: {
          id: "widget",
          repository: "acme/widget",
          defaultRef: "main",
          workspacePath: "/workspace/widget",
        },
        cube: {
          apiUrl: "https://sandbox.0iq.xyz",
          sandboxDomain: "sbx.0iq.xyz",
        },
        template: {
          alias: "widget",
          dockerfile: ".cube/Dockerfile",
          buildContext: ".",
          resources: {
            cpuMillicores: 2000,
            memoryMb: 4096,
            writableLayerSize: "20G",
          },
        },
        sandbox: {
          idleTimeoutSeconds: 300,
          onTimeout: "pause",
          previewPorts: [],
        },
        snapshot: { mode: "manual" },
      }),
    );
    vi.stubEnv("CUBESANDBOX_PASEO_STATE_DIR", stateDirectory);

    const project = {
      projectId: "prj_nested",
      projectDisplayName: "Nested project",
      projectRootPath: nestedProjectRoot,
      projectKind: "git",
    } as unknown as PaseoProject;
    const paseo = {
      projects: {
        list: vi.fn(async () => ({ requestId: "test", projects: [project] })),
      },
      workspaces: {
        list: vi.fn(async () => ({
          requestId: "test",
          entries: [],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        })),
      },
    } as unknown as PaseoApi;
    let agentCreateHook:
      | ((input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>)
      | undefined;
    let sessionOpenHook:
      | ((input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>)
      | undefined;
    const server = {
      before: vi.fn((name: string, handler: unknown) => {
        if (name === "agent.create") {
          agentCreateHook = handler as typeof agentCreateHook;
        }
        if (name === "agent.session_open") {
          sessionOpenHook = handler as typeof sessionOpenHook;
        }
        return vi.fn();
      }),
      on: vi.fn(() => vi.fn()),
      handle: vi.fn(),
      registerSettings: vi.fn(),
    } as unknown as PluginServerContext;
    const cleanup = contributeServer(server);

    const transformed = (await agentCreateHook!(
      { request: { config: { cwd: nestedProjectRoot, mcpServers: {} } } },
      { paseo },
    )) as {
      env: Record<string, string>;
      config: {
        mcpServers: { cubesandbox: { type: string; url: string } };
      };
    };
    const opened = (await sessionOpenHook!(
      {
        request: {
          agentId: "coordinator-1",
          workspaceId: null,
          provider: "codex",
          cwd: nestedProjectRoot,
          reason: "create",
          purpose: "interactive",
          env: transformed.env,
        },
      },
      { paseo },
    )) as { env: Record<string, string> };
    expect(opened.env).toEqual({});
    const client = new Client({ name: "nested-root-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(transformed.config.mcpServers.cubesandbox.url),
      ),
    );
    try {
      const result = await client.callTool({
        name: "cube_init_config",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        path.join(repositoryRoot, ".cube", "config.json"),
      );
      await expect(
        stat(path.join(nestedProjectRoot, ".cube")),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await cleanup?.();
    }
  });

  it("injects managed-workspace tools and lists work without creating a sandbox", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "cube-hook-project-"),
    );
    const workspaceRoot = await mkdtemp(
      path.join(os.tmpdir(), "cube-hook-workspace-"),
    );
    const stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cube-hook-state-"),
    );
    vi.stubEnv("CUBESANDBOX_PASEO_STATE_DIR", stateDirectory);

    const project = {
      projectId: "prj_project",
      projectDisplayName: "Project",
      projectRootPath: projectRoot,
      projectKind: "git",
    } as unknown as PaseoProject;
    const workspace = {
      id: "wks_managed",
      projectId: project.projectId,
      projectDisplayName: project.projectDisplayName,
      projectRootPath: projectRoot,
      workspaceDirectory: workspaceRoot,
      projectKind: "git",
      workspaceKind: "worktree",
      name: "Managed worktree",
      archivingAt: null,
    } as unknown as PaseoWorkspace;
    const paseo = {
      projects: {
        list: vi.fn(async () => ({ requestId: "test", projects: [project] })),
      },
      workspaces: {
        list: vi.fn(async () => ({
          requestId: "test",
          entries: [workspace],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        })),
      },
    } as unknown as PaseoApi;

    let agentCreateHook:
      | ((input: unknown, context: { paseo: PaseoApi }) => Promise<unknown>)
      | undefined;
    const server = {
      before: vi.fn((name: string, handler: unknown) => {
        if (name === "agent.create") {
          agentCreateHook = handler as typeof agentCreateHook;
        }
        return vi.fn();
      }),
      on: vi.fn(() => vi.fn()),
      handle: vi.fn(),
      registerSettings: vi.fn(() => ({
        read: vi.fn(),
        subscribe: vi.fn(() => () => undefined),
      })),
    } as unknown as PluginServerContext;
    const cleanup = contributeServer(server);
    expect(agentCreateHook).toBeDefined();

    const transformed = (await agentCreateHook!(
      { request: { config: { cwd: workspaceRoot, mcpServers: {} } } },
      { paseo },
    )) as {
      config: {
        mcpServers: { cubesandbox: { type: string; url: string } };
      };
    };
    const capability = transformed.config.mcpServers.cubesandbox;
    expect(capability.type).toBe("http");

    const client = new Client({
      name: "managed-workspace-test",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(capability.url),
    );
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(10);
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "cube_get_work_events",
      );
      const createAgentTool = tools.tools.find(
        (tool) => tool.name === "cube_create_agent",
      );
      expect(createAgentTool?.description).toContain("timeoutMs");
      expect(createAgentTool?.inputSchema).toMatchObject({
        properties: { timeoutMs: expect.any(Object) },
      });
      const activityTool = tools.tools.find(
        (tool) => tool.name === "cube_get_activity",
      );
      expect(activityTool?.description).toContain(
        "remote Paseo agent timeline",
      );
      expect(activityTool?.inputSchema).toMatchObject({
        properties: {
          agentId: expect.any(Object),
          cursor: expect.any(Object),
          direction: expect.any(Object),
        },
      });
      const result = await client.callTool({
        name: "cube_list_work",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ works: [] });
      await expect(
        readdir(path.join(stateDirectory, "work-records")),
      ).resolves.toEqual([]);
    } finally {
      await client.close();
      await cleanup?.();
    }
  });

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
      on: vi.fn(() => vi.fn()),
      handle: vi.fn(),
      registerSettings: vi.fn(() => ({
        read: vi.fn(),
        subscribe: vi.fn(() => () => undefined),
      })),
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
