import { z } from "zod";

import type { CubeProjectConfig } from "../shared/config.js";
import { Config } from "./vendor/cubesandbox-sdk/config.js";
import { Sandbox } from "./vendor/cubesandbox-sdk/sandbox.js";

const snapshotSchema = z
  .object({
    snapshotID: z.string().min(1),
    names: z.array(z.string()).default([]),
  })
  .passthrough();

const sandboxInfoSchema = z
  .object({
    sandboxID: z.string().min(1).optional(),
    state: z.string().min(1),
  })
  .passthrough();

export interface CubeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CubeSandboxHandle {
  readonly sandboxId: string;
  run(
    command: string,
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CubeCommandResult>;
  info(): Promise<{ state: string }>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
}

export interface CubeRuntime {
  resolveSnapshot(config: CubeProjectConfig): Promise<string>;
  create(config: CubeProjectConfig, workId: string): Promise<CubeSandboxHandle>;
  inspect(
    config: CubeProjectConfig,
    sandboxId: string,
  ): Promise<{ state: string }>;
  pause(config: CubeProjectConfig, sandboxId: string): Promise<void>;
  destroy(config: CubeProjectConfig, sandboxId: string): Promise<void>;
  connect(
    config: CubeProjectConfig,
    sandboxId: string,
  ): Promise<CubeSandboxHandle>;
}

function connectionConfig(config: CubeProjectConfig) {
  return {
    apiUrl: config.cube.apiUrl,
    apiKey: process.env.CUBE_API_KEY,
    sandboxDomain: config.cube.sandboxDomain,
    proxyPort: 443,
    proxyScheme: "https",
  };
}

function runtimeEnvironment(): Record<string, string> {
  const names = [
    "ANTHROPIC_API_KEY",
    "CODEX_API_KEY",
    "GEMINI_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
}

function wrapSandbox(sandbox: Sandbox): CubeSandboxHandle {
  if (!sandbox.sandboxId)
    throw new Error("CubeSandbox response omitted sandboxID");
  return {
    sandboxId: sandbox.sandboxId,
    run: async (command, options) => {
      const result = await sandbox.commands.run(command, {
        cwd: options?.cwd,
        envs: options?.env,
        timeoutMs: 180_000,
        user: "coder",
      });
      return z
        .object({
          stdout: z.string(),
          stderr: z.string(),
          exitCode: z.number().int(),
        })
        .strict()
        .parse(result);
    },
    info: async () => {
      const info = sandboxInfoSchema.parse(await sandbox.getInfo());
      return { state: info.state };
    },
    pause: () => sandbox.pause(),
    destroy: () => sandbox.kill(),
  };
}

export class CubeSdkRuntime implements CubeRuntime {
  async resolveSnapshot(config: CubeProjectConfig): Promise<string> {
    if (config.snapshot.id) return config.snapshot.id;
    const snapshots = z.array(snapshotSchema).parse(
      await Sandbox.listSnapshots({
        limit: 100,
        config: connectionConfig(config),
      }),
    );
    const latest = snapshots.find((snapshot) =>
      snapshot.names.includes(config.template.alias),
    );
    if (!latest) {
      throw new Error(
        `No prepared snapshot named ${JSON.stringify(config.template.alias)}. Run .cube/sandbox.py prepare-snapshot first.`,
      );
    }
    return latest.snapshotID;
  }

  async create(
    config: CubeProjectConfig,
    workId: string,
  ): Promise<CubeSandboxHandle> {
    const snapshotId = await this.resolveSnapshot(config);
    return wrapSandbox(
      await Sandbox.create({
        template: snapshotId,
        timeout: config.sandbox.idleTimeoutSeconds,
        envVars: runtimeEnvironment(),
        metadata: {
          "paseo.workId": workId,
          "paseo.projectId": config.project.id,
        },
        lifecycle: { onTimeout: "pause", autoResume: false },
        config: connectionConfig(config),
      }),
    );
  }

  async connect(
    config: CubeProjectConfig,
    sandboxId: string,
  ): Promise<CubeSandboxHandle> {
    return wrapSandbox(
      await Sandbox.connect(sandboxId, {
        config: connectionConfig(config),
      }),
    );
  }

  async inspect(
    config: CubeProjectConfig,
    sandboxId: string,
  ): Promise<{ state: string }> {
    const sandbox = this.unconnectedSandbox(config, sandboxId);
    const info = sandboxInfoSchema.parse(await sandbox.getInfo());
    return { state: info.state };
  }

  async pause(config: CubeProjectConfig, sandboxId: string): Promise<void> {
    await this.unconnectedSandbox(config, sandboxId).pause();
  }

  async destroy(config: CubeProjectConfig, sandboxId: string): Promise<void> {
    await this.unconnectedSandbox(config, sandboxId).kill();
  }

  private unconnectedSandbox(
    config: CubeProjectConfig,
    sandboxId: string,
  ): Sandbox {
    return new Sandbox(
      { sandboxID: sandboxId },
      new Config(connectionConfig(config)),
    );
  }
}
