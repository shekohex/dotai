import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CUBE_CONFIG_SCHEMA_URL,
  cubeProjectConfigSchema,
} from "../shared/config.js";
import { CubeSdkRuntime } from "./cube-runtime.js";
import { Config } from "./vendor/cubesandbox-sdk/config.js";
import { TemplateNotFoundError } from "./vendor/cubesandbox-sdk/exceptions.js";
import { Filesystem } from "./vendor/cubesandbox-sdk/filesystem.js";
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
    snapshot: { mode: "manual", ...(snapshotId ? { id: snapshotId } : {}) },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("CubeSdkRuntime", () => {
  it("creates from the configured template when no snapshot is available", async () => {
    vi.spyOn(Sandbox, "listSnapshots").mockResolvedValue([]);
    const create = vi.spyOn(Sandbox, "create").mockResolvedValue(
      new Sandbox(
        { sandboxID: "sandbox-template", domain: "sbx.0iq.xyz" },
        new Config({
          apiUrl: "https://sandbox.0iq.xyz",
          sandboxDomain: "sbx.0iq.xyz",
        }),
      ),
    );

    const sandbox = await new CubeSdkRuntime().create(
      projectConfig(),
      "work-template",
    );

    expect(sandbox.sandboxId).toBe("sandbox-template");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ template: "widget" }),
    );
  });

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

  it("uses an available snapshot before falling back to the template", async () => {
    const listSnapshots = vi
      .spyOn(Sandbox, "listSnapshots")
      .mockResolvedValue([{ snapshotID: "latest", names: ["widget"] }]);
    const create = vi.spyOn(Sandbox, "create").mockResolvedValue(
      new Sandbox(
        { sandboxID: "sandbox-snapshot", domain: "sbx.0iq.xyz" },
        new Config({
          apiUrl: "https://sandbox.0iq.xyz",
          sandboxDomain: "sbx.0iq.xyz",
        }),
      ),
    );
    const runtime = new CubeSdkRuntime();

    await runtime.create(projectConfig(), "work-snapshot");
    await runtime.create(projectConfig("pinned"), "work-pinned");

    expect(listSnapshots).toHaveBeenCalledOnce();
    expect(create.mock.calls.map(([options]) => options.template)).toEqual([
      "latest",
      "pinned",
    ]);
  });

  it("surfaces a missing template without snapshot guidance", async () => {
    vi.spyOn(Sandbox, "listSnapshots").mockResolvedValue([]);
    vi.spyOn(Sandbox, "create").mockRejectedValue(
      new TemplateNotFoundError('Template "widget" was not found', 404),
    );

    await expect(
      new CubeSdkRuntime().create(projectConfig(), "work-missing-template"),
    ).rejects.toThrow('Template "widget" was not found');
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

  it("rejects a repository-controlled sandbox domain before requests or secret reads", async () => {
    const secretReads: string[] = [];
    const environment = new Proxy(
      {
        CUBE_API_URL: "https://sandbox.0iq.xyz",
        CUBE_SANDBOX_DOMAIN: "sbx.0iq.xyz",
      } as NodeJS.ProcessEnv,
      {
        get(target, property, receiver) {
          if (
            typeof property === "string" &&
            property !== "CUBE_API_URL" &&
            property !== "CUBE_SANDBOX_DOMAIN"
          ) {
            secretReads.push(property);
          }
          return Reflect.get(target, property, receiver) as string | undefined;
        },
      },
    );
    const create = vi.spyOn(Sandbox, "create");
    const config = projectConfig("pinned");
    config.cube.sandboxDomain = "attacker.example";

    await expect(
      new CubeSdkRuntime(environment).create(config, "work-1"),
    ).rejects.toThrow("does not match trusted Cube sandbox domain");
    expect(create).not.toHaveBeenCalled();
    expect(secretReads).toEqual([]);
  });

  it.each([undefined, "attacker.example"])(
    "rejects response domain %s before forwarding runtime secrets",
    async (domain) => {
      const create = vi.spyOn(Sandbox, "create").mockResolvedValue(
        new Sandbox(
          {
            sandboxID: "sandbox-hostile",
            ...(domain ? { domain } : {}),
          },
          new (await import("./vendor/cubesandbox-sdk/config.js")).Config({
            apiUrl: "https://sandbox.0iq.xyz",
            sandboxDomain: "sbx.0iq.xyz",
          }),
        ),
      );
      const kill = vi
        .spyOn(Sandbox.prototype, "kill")
        .mockResolvedValue(undefined);
      const runtime = new CubeSdkRuntime({
        CUBE_API_URL: "https://sandbox.0iq.xyz",
        CUBE_SANDBOX_DOMAIN: "sbx.0iq.xyz",
        CUBE_API_KEY: "control-secret",
        OPENAI_API_KEY: "never-forward-this-secret",
      });

      await expect(
        runtime.create(projectConfig("pinned"), "work-1"),
      ).rejects.toThrow("response domain");
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ envVars: {} }),
      );
      expect(JSON.stringify(create.mock.calls)).not.toContain(
        "never-forward-this-secret",
      );
      expect(kill).toHaveBeenCalledOnce();
    },
  );

  it("writes runtime identity only through validated sandbox data plane", async () => {
    vi.spyOn(Sandbox, "create").mockResolvedValue(
      new Sandbox(
        { sandboxID: "sandbox-1", domain: "sbx.0iq.xyz" },
        new (await import("./vendor/cubesandbox-sdk/config.js")).Config({
          apiUrl: "https://sandbox.0iq.xyz",
          sandboxDomain: "sbx.0iq.xyz",
        }),
      ),
    );
    const write = vi
      .spyOn(Filesystem.prototype, "write")
      .mockResolvedValue(undefined);

    const sandbox = await new CubeSdkRuntime().create(
      projectConfig("pinned"),
      "work-1",
    );
    await sandbox.writeFile(
      "/home/coder/.codex/auth.json",
      '{"token":"secret"}\n',
    );

    expect(write).toHaveBeenCalledWith(
      "/home/coder/.codex/auth.json",
      '{"token":"secret"}\n',
      { user: "coder" },
    );
  });
});
