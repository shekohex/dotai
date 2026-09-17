import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CUBE_CONFIG_SCHEMA_URL } from "../shared/config.js";
import type { CubeRuntime, CubeSandboxHandle } from "./cube-runtime.js";
import type {
  RemotePaseoConnection,
  RemotePaseoConnector,
  RemoteAgentInput,
} from "./remote-paseo.js";
import { WorkRecordStore } from "./work-record.js";
import { WorkService } from "./work-service.js";

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-work-service-"));
  await mkdir(path.join(root, ".cube"));
  await writeFile(
    path.join(root, ".cube", "config.json"),
    JSON.stringify({
      $schema: CUBE_CONFIG_SCHEMA_URL,
      version: 1,
      project: {
        id: "widget",
        repository: "acme/widget",
        defaultRef: "main",
        workspacePath: "/workspace/widget",
      },
      cube: { apiUrl: "https://sandbox.0iq.xyz", sandboxDomain: "sbx.0iq.xyz" },
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
        previewPorts: [3000],
      },
      snapshot: { mode: "manual", id: "snapshot-1" },
    }),
  );
  return root;
}

function dependencies() {
  const pause = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const run = vi.fn(async (command: string) => ({
    stdout: command.includes("daemon pair")
      ? JSON.stringify({
          relayEnabled: true,
          url: "https://app.paseo.sh/#offer=test",
          qr: null,
        })
      : "",
    stderr: "",
    exitCode: 0,
  }));
  const sandbox: CubeSandboxHandle = {
    sandboxId: "sandbox-1",
    run,
    info: vi.fn(async () => ({ state: "running" })),
    pause,
    destroy,
  };
  const cube: CubeRuntime = {
    resolveSnapshot: vi.fn(async () => "snapshot-1"),
    create: vi.fn(async () => sandbox),
    inspect: vi.fn(async () => sandbox.info()),
    pause: vi.fn(async () => pause()),
    destroy: vi.fn(async () => destroy()),
    connect: vi.fn(async () => sandbox),
  };
  const createdAgents: RemoteAgentInput[] = [];
  const remote: RemotePaseoConnection = {
    serverId: "remote-1",
    createAgent: vi.fn(async (input) => {
      createdAgents.push(input);
      return {
        agentId: `agent-${createdAgents.length}`,
        workspaceId: `workspace-${createdAgents.length}`,
      };
    }),
    sendPrompt: vi.fn(async () => undefined),
    hasBusyAgent: vi.fn(async () => false),
    close: vi.fn(async () => undefined),
  };
  const paseo: RemotePaseoConnector = { connect: vi.fn(async () => remote) };
  return { cube, paseo, sandbox, pause, destroy, run, remote, createdAgents };
}

describe("WorkService lifecycle", () => {
  it("creates one sandbox, then adds isolated remote worktree agents", async () => {
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const deps = dependencies();
    const service = new WorkService(
      new WorkRecordStore(state),
      deps.cube,
      deps.paseo,
    );

    const first = await service.createAgent(repositoryRoot, {
      prompt: "first",
    });
    const second = await service.createAgent(repositoryRoot, {
      prompt: "second",
      workId: first.workId,
    });

    expect(deps.cube.create).toHaveBeenCalledTimes(1);
    expect(second.agentCount).toBe(2);
    expect(deps.createdAgents.map((agent) => agent.ordinal)).toEqual([1, 2]);
    expect(deps.createdAgents.map((agent) => agent.workspacePath)).toEqual([
      "/workspace/widget",
      "/workspace/widget",
    ]);
    expect(deps.run).toHaveBeenCalledTimes(4);
  });

  it("pauses immediately and destroys without confirmation", async () => {
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const deps = dependencies();
    const service = new WorkService(
      new WorkRecordStore(state),
      deps.cube,
      deps.paseo,
    );
    const work = await service.createAgent(repositoryRoot, { prompt: "first" });

    expect((await service.pause(repositoryRoot, work.workId)).status).toBe(
      "paused",
    );
    expect(deps.pause).toHaveBeenCalledOnce();
    await service.destroy(repositoryRoot, work.workId);
    expect(deps.destroy).toHaveBeenCalledOnce();
    await expect(
      service.getStatus(repositoryRoot, work.workId),
    ).rejects.toThrow();
  });

  it("inspects status without resuming a paused sandbox", async () => {
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const deps = dependencies();
    const service = new WorkService(
      new WorkRecordStore(state),
      deps.cube,
      deps.paseo,
    );
    const work = await service.createAgent(repositoryRoot, { prompt: "first" });
    vi.mocked(deps.cube.inspect).mockResolvedValue({ state: "paused" });

    expect((await service.getStatus(repositoryRoot, work.workId)).status).toBe(
      "paused",
    );
    expect(deps.cube.connect).not.toHaveBeenCalled();
  });

  it("rejects another repository capability", async () => {
    const repositoryRoot = await projectFixture();
    const otherRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const deps = dependencies();
    const service = new WorkService(
      new WorkRecordStore(state),
      deps.cube,
      deps.paseo,
    );
    const work = await service.createAgent(repositoryRoot, { prompt: "first" });

    await expect(service.pause(otherRoot, work.workId)).rejects.toThrow(
      "not owned by this repository capability",
    );
  });
});
