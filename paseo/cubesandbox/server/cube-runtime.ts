import { z } from "zod";

import type { CubeProjectConfig } from "../shared/config.js";
import { Config } from "./vendor/cubesandbox-sdk/config.js";
import { Sandbox } from "./vendor/cubesandbox-sdk/sandbox.js";

const DEFAULT_CUBE_API_URL = "https://sandbox.0iq.xyz";
const RUNTIME_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
] as const;

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
  keepAlive(): Promise<void>;
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

function normalizeCubeApiUrl(value: string, source: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${source} must use http or https`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `${source} must not contain credentials, query, or fragment`,
    );
  }
  return value.replace(/\/+$/, "");
}

function connectionConfig(
  config: CubeProjectConfig,
  environment: NodeJS.ProcessEnv,
) {
  const trustedApiUrl = normalizeCubeApiUrl(
    environment.CUBE_API_URL ?? DEFAULT_CUBE_API_URL,
    "Trusted Cube API URL",
  );
  const configuredApiUrl = normalizeCubeApiUrl(
    config.cube.apiUrl,
    "Project cube.apiUrl",
  );
  if (configuredApiUrl !== trustedApiUrl) {
    throw new Error(
      `Project cube.apiUrl ${JSON.stringify(config.cube.apiUrl)} does not match trusted Cube API URL ${JSON.stringify(trustedApiUrl)}`,
    );
  }
  return {
    apiUrl: trustedApiUrl,
    apiKey: environment.CUBE_API_KEY ?? null,
    sandboxDomain: config.cube.sandboxDomain,
    proxyPort: 443,
    proxyScheme: "https",
  };
}

function runtimeEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    RUNTIME_SECRET_NAMES.flatMap((name) => {
      const value = environment[name];
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
    keepAlive: async () => {
      const result = await sandbox.commands.run("true", {
        timeoutMs: 10_000,
        user: "coder",
      });
      if (result.exitCode !== 0) {
        throw new Error(`Cube keepalive failed with exit ${result.exitCode}`);
      }
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
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async resolveSnapshot(config: CubeProjectConfig): Promise<string> {
    const trustedConnection = connectionConfig(config, this.environment);
    if (config.snapshot.id) return config.snapshot.id;
    const snapshots = z.array(snapshotSchema).parse(
      await Sandbox.listSnapshots({
        limit: 100,
        config: trustedConnection,
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
    const trustedConnection = connectionConfig(config, this.environment);
    const snapshotId = config.snapshot.id
      ? config.snapshot.id
      : await this.resolveSnapshot(config);
    return wrapSandbox(
      await Sandbox.create({
        template: snapshotId,
        timeout: config.sandbox.idleTimeoutSeconds,
        envVars: runtimeEnvironment(this.environment),
        metadata: {
          "paseo.workId": workId,
          "paseo.projectId": config.project.id,
        },
        lifecycle: { onTimeout: "pause", autoResume: false },
        config: trustedConnection,
      }),
    );
  }

  async connect(
    config: CubeProjectConfig,
    sandboxId: string,
  ): Promise<CubeSandboxHandle> {
    return wrapSandbox(
      await Sandbox.connect(sandboxId, {
        config: connectionConfig(config, this.environment),
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
      new Config(connectionConfig(config, this.environment)),
    );
  }
}
