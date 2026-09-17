import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CUBE_CONFIG_SCHEMA_URL,
  cubeProjectConfigSchema,
} from "../shared/config.js";
import { CubeSdkRuntime } from "./cube-runtime.js";
import { Sandbox } from "./vendor/cubesandbox-sdk/sandbox.js";

function projectConfig(
  snapshotId?: string,
  apiUrl = "https://sandbox.0iq.xyz",
) {
  return cubeProjectConfigSchema.parse({
    $schema: CUBE_CONFIG_SCHEMA_URL,
    version: 1,
    project: {
      id: "widget",
      repository: "acme/widget",
      defaultRef: "main",
      workspacePath: "/workspace/widget",
    },
    cube: {
      apiUrl,
      sandboxDomain: "sbx.example.test",
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
    snapshot: { mode: "manual", ...(snapshotId ? { id: snapshotId } : {}) },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("CubeSdkRuntime", () => {
  it("uses a pinned snapshot or newest matching alias", async () => {
    const listSnapshots = vi.spyOn(Sandbox, "listSnapshots").mockResolvedValue([
      { snapshotID: "latest", names: ["widget"] },
      { snapshotID: "older", names: ["widget"] },
    ]);
    const runtime = new CubeSdkRuntime();

    await expect(runtime.resolveSnapshot(projectConfig())).resolves.toBe(
      "latest",
    );
    await expect(
      runtime.resolveSnapshot(projectConfig("pinned")),
    ).resolves.toBe("pinned");
    expect(listSnapshots).toHaveBeenCalledOnce();
  });

  it("inspects, pauses, and destroys without calling auto-resuming connect", async () => {
    vi.spyOn(Sandbox.prototype, "getInfo").mockResolvedValue({
      sandboxID: "sandbox-1",
      state: "paused",
    });
    const pause = vi
      .spyOn(Sandbox.prototype, "pause")
      .mockResolvedValue(undefined);
    const kill = vi
      .spyOn(Sandbox.prototype, "kill")
      .mockResolvedValue(undefined);
    const connect = vi.spyOn(Sandbox, "connect");
    const runtime = new CubeSdkRuntime();
    const config = projectConfig("pinned");

    await expect(runtime.inspect(config, "sandbox-1")).resolves.toEqual({
      state: "paused",
    });
    await runtime.pause(config, "sandbox-1");
    await runtime.destroy(config, "sandbox-1");

    expect(pause).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a repository-controlled API endpoint before requests or secret reads", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(500).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind an IP port");
    }
    const secretReads: string[] = [];
    const environment = new Proxy({} as NodeJS.ProcessEnv, {
      get(target, property, receiver) {
        if (typeof property === "string" && property !== "CUBE_API_URL") {
          secretReads.push(property);
        }
        return Reflect.get(target, property, receiver) as string | undefined;
      },
    });

    try {
      const runtime = new CubeSdkRuntime(environment);
      await expect(
        runtime.create(
          projectConfig("pinned", `http://127.0.0.1:${address.port}`),
          "f4e30d8d-ef62-4b9d-ac62-3c3875660018",
        ),
      ).rejects.toThrow("does not match trusted Cube API URL");
      expect(requestCount).toBe(0);
      expect(secretReads).toEqual([]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
