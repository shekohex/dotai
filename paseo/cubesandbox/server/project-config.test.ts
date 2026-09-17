import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { CUBE_CONFIG_SCHEMA_URL } from "../shared/config.js";
import {
  initializeProjectConfig,
  repositoryFromRemote,
} from "./project-config.js";

const executeFile = promisify(execFile);

describe("repositoryFromRemote", () => {
  it.each([
    ["git@github.com:acme/widget.git", "acme/widget"],
    ["https://github.com/acme/widget.git", "acme/widget"],
    ["ssh://git@example.test/acme/widget.git", "acme/widget"],
  ])("normalizes %s", (remote, expected) => {
    expect(repositoryFromRemote(remote)).toBe(expected);
  });
});

describe("initializeProjectConfig", () => {
  it("creates only config.json and refuses overwrite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cube-config-test-"));
    await executeFile("git", ["init", "-b", "main", root]);
    await executeFile("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "git@github.com:acme/widget.git",
    ]);

    const configPath = await initializeProjectConfig(root);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config).toEqual({
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
    });
    expect((await stat(path.join(root, ".cube"))).isDirectory()).toBe(true);
    await expect(initializeProjectConfig(root)).rejects.toThrow(
      "Refusing to overwrite",
    );
  });
});
