import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CUBE_CONFIG_SCHEMA_URL } from "../shared/config.js";
import type { CubeRuntime, CubeSandboxHandle } from "./cube-runtime.js";
import {
  remoteBranchName,
  type RemoteAgentInput,
  type RemotePaseoConnection,
  type RemotePaseoConnector,
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

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await delay(1);
  }
  throw new Error("Timed out waiting for asynchronous timer callback");
}

async function waitForRecordStatus(
  store: WorkRecordStore,
  workId: string,
  status: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await store.get(workId)).status === status) return;
    await delay(1);
  }
  throw new Error(`Timed out waiting for WorkRecord status ${status}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function dependencies() {
  const pause = vi.fn(async () => undefined);
  const destroy = vi.fn(async () => undefined);
  const keepAlive = vi.fn(async () => undefined);
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
    keepAlive,
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
    discardAgent: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => undefined),
    hasBusyAgent: vi.fn(async () => false),
    close: vi.fn(async () => undefined),
  };
  const paseo: RemotePaseoConnector = { connect: vi.fn(async () => remote) };
  return {
    cube,
    paseo,
    sandbox,
    pause,
    destroy,
    keepAlive,
    run,
    remote,
    createdAgents,
  };
}

afterEach(() => vi.useRealTimers());

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

  it("serializes concurrent agent creation for one work", async () => {
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const store = new WorkRecordStore(state);
    const deps = dependencies();
    const service = new WorkService(store, deps.cube, deps.paseo);
    const work = await service.createAgent(repositoryRoot, { prompt: "first" });

    const [second, third] = await Promise.all([
      service.createAgent(repositoryRoot, {
        prompt: "second",
        workId: work.workId,
      }),
      service.createAgent(repositoryRoot, {
        prompt: "third",
        workId: work.workId,
      }),
    ]);

    expect(deps.createdAgents.map((agent) => agent.ordinal)).toEqual([1, 2, 3]);
    expect(
      deps.createdAgents.map((agent) =>
        remoteBranchName(agent.workId, agent.ordinal),
      ),
    ).toEqual([
      `cube/${work.workId}/1`,
      `cube/${work.workId}/2`,
      `cube/${work.workId}/3`,
    ]);
    expect(second.agentCount).toBe(2);
    expect(third.agentCount).toBe(3);
    expect((await store.get(work.workId)).agents).toHaveLength(3);
    expect(
      (await store.get(work.workId)).agents.map((agent) => agent.workspaceId),
    ).toEqual(["workspace-1", "workspace-2", "workspace-3"]);
    await service.close();
  });

  it("archives a remote workspace when local agent persistence fails", async () => {
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const store = new WorkRecordStore(state);
    const deps = dependencies();
    const service = new WorkService(store, deps.cube, deps.paseo);
    const work = await service.createAgent(repositoryRoot, { prompt: "first" });
    vi.spyOn(store, "save").mockRejectedValueOnce(
      new Error("simulated persistence failure"),
    );

    await expect(
      service.createAgent(repositoryRoot, {
        prompt: "second",
        workId: work.workId,
      }),
    ).rejects.toThrow("simulated persistence failure");
    expect(deps.remote.discardAgent).toHaveBeenCalledWith({
      agentId: "agent-2",
      workspaceId: "workspace-2",
    });
    expect((await store.get(work.workId)).agents).toHaveLength(1);
    await service.close();
  });

  it("keeps a busy remote agent active, then starts idle grace", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const store = new WorkRecordStore(state);
    const deps = dependencies();
    vi.mocked(deps.remote.hasBusyAgent).mockResolvedValue(true);
    const service = new WorkService(store, deps.cube, deps.paseo);
    const work = await service.createAgent(repositoryRoot, { prompt: "long" });

    expect(vi.getTimerCount()).toBe(1);
    for (let check = 0; check < 6; check += 1) {
      await vi.advanceTimersToNextTimerAsync();
      await waitForCondition(() => deps.keepAlive.mock.calls.length > check);
    }
    expect(deps.keepAlive.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect((await store.get(work.workId)).status).toBe("busy");

    vi.mocked(deps.remote.hasBusyAgent).mockResolvedValue(false);
    const beforeIdle = deps.keepAlive.mock.calls.length;
    await vi.advanceTimersToNextTimerAsync();
    await waitForCondition(
      () => deps.keepAlive.mock.calls.length === beforeIdle + 1,
    );
    await waitForRecordStatus(store, work.workId, "ready");
    expect(deps.keepAlive).toHaveBeenCalledTimes(beforeIdle + 1);
    expect((await store.get(work.workId)).status).toBe("ready");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(deps.keepAlive).toHaveBeenCalledTimes(beforeIdle + 1);
    await service.close();
  });

  it("does not postpone keepalive when status is polled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const deps = dependencies();
    vi.mocked(deps.remote.hasBusyAgent).mockResolvedValue(true);
    const service = new WorkService(
      new WorkRecordStore(state),
      deps.cube,
      deps.paseo,
    );
    const work = await service.createAgent(repositoryRoot, { prompt: "long" });

    for (let poll = 0; poll < 5; poll += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        (await service.getStatus(repositoryRoot, work.workId)).status,
      ).toBe("busy");
    }
    await vi.advanceTimersByTimeAsync(10_000);
    await waitForCondition(() => deps.keepAlive.mock.calls.length === 1);

    expect(deps.keepAlive).toHaveBeenCalledOnce();
    await service.close();
  });

  it.each(["pause", "destroy", "close"] as const)(
    "cancels keepalive on %s",
    async (cleanup) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const repositoryRoot = await projectFixture();
      const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
      const deps = dependencies();
      vi.mocked(deps.remote.hasBusyAgent).mockResolvedValue(true);
      const service = new WorkService(
        new WorkRecordStore(state),
        deps.cube,
        deps.paseo,
      );
      const work = await service.createAgent(repositoryRoot, {
        prompt: "long",
      });

      if (cleanup === "pause") {
        await service.pause(repositoryRoot, work.workId);
      } else if (cleanup === "destroy") {
        await service.destroy(repositoryRoot, work.workId);
      } else {
        await service.close();
      }
      await vi.advanceTimersByTimeAsync(360_000);
      expect(deps.keepAlive).not.toHaveBeenCalled();
    },
  );

  it("recovers busy-work keepalive after plugin reload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const store = new WorkRecordStore(state);
    const firstDependencies = dependencies();
    const firstService = new WorkService(
      store,
      firstDependencies.cube,
      firstDependencies.paseo,
    );
    await firstService.createAgent(repositoryRoot, { prompt: "long" });
    await firstService.close();

    const reloadedDependencies = dependencies();
    vi.mocked(reloadedDependencies.remote.hasBusyAgent).mockResolvedValue(true);
    const reloadedService = new WorkService(
      store,
      reloadedDependencies.cube,
      reloadedDependencies.paseo,
    );
    await reloadedService.start();
    await vi.advanceTimersToNextTimerAsync();
    await waitForCondition(
      () =>
        reloadedDependencies.keepAlive.mock.calls.length === 1 &&
        vi.getTimerCount() === 1,
    );

    expect(reloadedDependencies.cube.connect).toHaveBeenCalledOnce();
    await reloadedService.close();
  });

  it("drains and destroys creation blocked during shutdown", async () => {
    const repositoryRoot = await projectFixture();
    const state = await mkdtemp(path.join(os.tmpdir(), "cube-work-state-"));
    const store = new WorkRecordStore(state);
    const deps = dependencies();
    const pairingStarted = deferred<void>();
    const releasePairing = deferred<void>();
    deps.run.mockImplementation(async (command: string) => {
      if (!command.includes("daemon pair")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      pairingStarted.resolve();
      await releasePairing.promise;
      return {
        stdout: JSON.stringify({
          relayEnabled: true,
          url: "https://app.paseo.sh/#offer=test",
          qr: null,
        }),
        stderr: "",
        exitCode: 0,
      };
    });
    const service = new WorkService(store, deps.cube, deps.paseo);

    const creation = service.createAgent(repositoryRoot, { prompt: "first" });
    await pairingStarted.promise;
    const closing = service.close();
    let closeFinished = false;
    void closing.then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    expect(deps.sandbox.destroy).not.toHaveBeenCalled();
    await expect(
      service.createAgent(repositoryRoot, { prompt: "too late" }),
    ).rejects.toThrow("CubeSandbox service is closing");

    releasePairing.resolve();
    await expect(creation).rejects.toThrow("CubeSandbox service is closing");
    await closing;

    expect(closeFinished).toBe(true);
    expect(deps.sandbox.destroy).toHaveBeenCalledOnce();
    expect(deps.paseo.connect).not.toHaveBeenCalled();
    expect(deps.remote.close).not.toHaveBeenCalled();
    expect(deps.keepAlive).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
    expect(() => service.list()).toThrow("CubeSandbox service is closed");
    expect(service.close()).toBe(closing);
  });
});
