import { z } from "zod";

import type { CubeProjectConfig } from "../shared/config.js";
import { Config } from "./vendor/cubesandbox-sdk/config.js";
import { Sandbox } from "./vendor/cubesandbox-sdk/sandbox.js";

const DEFAULT_CUBE_API_URL = "https://sandbox.0iq.xyz";
const DEFAULT_CUBE_SANDBOX_DOMAIN = "sbx.0iq.xyz";
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
  writeFile(path: string, contents: string): Promise<void>;
  keepAlive(): Promise<void>;
  info(): Promise<{ state: string }>;
  pause(): Promise<void>;
  destroy(): Promise<void>;
}

export interface CubeRuntime {
  resolveSnapshot(config: CubeProjectConfig): Promise<string | undefined>;
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
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      `${source} must not contain credentials, path, query, or fragment`,
    );
  }
  return value.replace(/\/+$/, "");
}

function normalizeSandboxDomain(value: string, source: string): string {
  if (!value || value !== value.trim() || value.endsWith(".")) {
    throw new Error(`${source} must be a canonical hostname`);
  }
  const parsed = new URL(`https://${value}`);
  if (
    parsed.hostname !== value.toLowerCase() ||
    parsed.host !== value.toLowerCase() ||
    parsed.pathname !== "/"
  ) {
    throw new Error(`${source} must be a canonical hostname`);
  }
  return parsed.hostname;
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
  const trustedSandboxDomain = normalizeSandboxDomain(
    environment.CUBE_SANDBOX_DOMAIN ?? DEFAULT_CUBE_SANDBOX_DOMAIN,
    "Trusted Cube sandbox domain",
  );
  const configuredSandboxDomain = normalizeSandboxDomain(
    config.cube.sandboxDomain,
    "Project cube.sandboxDomain",
  );
  if (configuredSandboxDomain !== trustedSandboxDomain) {
    throw new Error(
      `Project cube.sandboxDomain ${JSON.stringify(config.cube.sandboxDomain)} does not match trusted Cube sandbox domain ${JSON.stringify(trustedSandboxDomain)}`,
    );
  }
  return {
    apiUrl: trustedApiUrl,
    apiKey: environment.CUBE_API_KEY ?? null,
    sandboxDomain: trustedSandboxDomain,
    proxyPort: 443,
    proxyScheme: "https",
  };
}

export function sandboxRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    RUNTIME_SECRET_NAMES.flatMap((name) => {
      const value = environment[name];
      return value ? [[name, value]] : [];
    }),
  );
}

function wrapSandbox(
  sandbox: Sandbox,
  trustedSandboxDomain: string,
): CubeSandboxHandle {
  if (!sandbox.sandboxId)
    throw new Error("CubeSandbox response omitted sandboxID");
  const responseDomain = sandbox.responseDomain;
  if (
    responseDomain === undefined ||
    normalizeSandboxDomain(responseDomain, "Cube response domain") !==
      trustedSandboxDomain
  ) {
    throw new Error(
      `Cube response domain ${JSON.stringify(responseDomain)} does not match trusted Cube sandbox domain ${JSON.stringify(trustedSandboxDomain)}`,
    );
  }
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
    writeFile: (path, contents) =>
      sandbox.files.write(path, contents, { user: "coder" }),
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

  async resolveSnapshot(
    config: CubeProjectConfig,
  ): Promise<string | undefined> {
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
    return latest?.snapshotID;
  }

  async create(
    config: CubeProjectConfig,
    workId: string,
  ): Promise<CubeSandboxHandle> {
    const trustedConnection = connectionConfig(config, this.environment);
    const snapshotId = await this.resolveSnapshot(config);
    const sandbox = await Sandbox.create({
      template: snapshotId ?? config.template.alias,
      timeout: config.sandbox.idleTimeoutSeconds,
      envVars: {},
      metadata: {
        "paseo.workId": workId,
        "paseo.projectId": config.project.id,
      },
      lifecycle: { onTimeout: "pause", autoResume: false },
      config: trustedConnection,
    });
    try {
      return wrapSandbox(sandbox, trustedConnection.sandboxDomain);
    } catch (validationError) {
      try {
        await sandbox.kill();
      } catch (cleanupError) {
        throw new AggregateError(
          [validationError, cleanupError],
          "Cube response validation and sandbox cleanup both failed",
        );
      }
      throw validationError;
    }
  }

  async connect(
    config: CubeProjectConfig,
    sandboxId: string,
  ): Promise<CubeSandboxHandle> {
    const trustedConnection = connectionConfig(config, this.environment);
    return wrapSandbox(
      await Sandbox.connect(sandboxId, { config: trustedConnection }),
      trustedConnection.sandboxDomain,
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
