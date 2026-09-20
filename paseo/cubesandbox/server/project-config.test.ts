import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { CUBE_CONFIG_SCHEMA_URL } from "../shared/config.js";
import {
  discoverGitProject,
  findGitRoot,
  initializeProjectConfig,
  initializeProjectConfigAtProjectRoot,
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
  it("identifies a non-Git context without resolving project metadata", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cube-non-git-"));

    await expect(findGitRoot(directory)).resolves.toBeNull();
  });

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
    await executeFile("git", [
      "-C",
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
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

  it("initializes at the Git top level from a nested launch path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cube-nested-test-"));
    await executeFile("git", ["init", "-b", "main", root]);
    await executeFile("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "git@github.com:acme/widget.git",
    ]);
    await executeFile("git", [
      "-C",
      root,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    const nested = path.join(root, "agent");
    await mkdir(nested, { recursive: true });

    const configPath = await initializeProjectConfigAtProjectRoot(nested);

    expect(configPath).toBe(path.join(root, ".cube", "config.json"));
    expect((await stat(path.join(root, ".cube"))).isDirectory()).toBe(true);
    await expect(stat(path.join(nested, ".cube"))).rejects.toThrow();
  });

  it("resolves advertised remote HEAD instead of the current feature branch", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "cube-ref-test-"));
    const remote = path.join(fixture, "remote.git");
    const seed = path.join(fixture, "seed");
    const project = path.join(fixture, "project");
    await executeFile("git", ["init", "--bare", remote]);
    await executeFile("git", ["init", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "fixture\n");
    await executeFile("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cube Test",
      "-c",
      "user.email=cube@example.test",
      "add",
      "README.md",
    ]);
    await executeFile("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cube Test",
      "-c",
      "user.email=cube@example.test",
      "commit",
      "-m",
      "fixture",
    ]);
    await executeFile("git", ["-C", seed, "remote", "add", "origin", remote]);
    await executeFile("git", ["-C", seed, "push", "origin", "main"]);
    await executeFile("git", [
      "-C",
      remote,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    await executeFile("git", ["init", "-b", "feature/review", project]);
    await executeFile("git", [
      "-C",
      project,
      "remote",
      "add",
      "origin",
      remote,
    ]);

    expect((await discoverGitProject(project)).defaultRef).toBe("main");
  });

  it("fails when origin does not advertise a default branch", async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), "cube-ref-test-"));
    const remote = path.join(fixture, "empty.git");
    const project = path.join(fixture, "project");
    await executeFile("git", ["init", "--bare", remote]);
    await executeFile("git", ["init", "-b", "feature/review", project]);
    await executeFile("git", [
      "-C",
      project,
      "remote",
      "add",
      "origin",
      remote,
    ]);

    await expect(discoverGitProject(project)).rejects.toThrow(
      "Cannot determine origin default branch",
    );
  });
});
