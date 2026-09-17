import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { CubeProjectConfig } from "../shared/config.js";
import { workStatusSchema, workSummarySchema } from "../shared/contracts.js";
import { type CubeRuntime, type CubeSandboxHandle } from "./cube-runtime.js";
import {
  initializeProjectConfig,
  loadProjectConfig,
} from "./project-config.js";
import {
  type RemotePaseoConnection,
  type RemotePaseoConnector,
} from "./remote-paseo.js";
import { type WorkRecord, WorkRecordStore } from "./work-record.js";

const pairingOutputSchema = z
  .object({
    relayEnabled: z.literal(true),
    url: z.string().url(),
    qr: z.string().nullable().optional(),
  })
  .strict();

export const createAgentInputSchema = z
  .object({
    prompt: z.string().min(1),
    workId: z.string().uuid().optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mode: z.string().min(1).optional(),
    thinking: z.string().min(1).optional(),
    task: z
      .object({
        source: z.string().min(1),
        id: z.string().min(1),
        title: z.string().min(1).optional(),
        url: z.string().url().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export interface WorkSummary {
  workId: string;
  sandboxId: string;
  projectId: string;
  repository: string;
  status: z.infer<typeof workStatusSchema>;
  idleTimeoutSeconds: number;
  updatedAt: string;
  pausedAt?: string;
  worktreeCount: number;
  agentCount: number;
  agents: WorkRecord["agents"];
  previewUrls: string[];
  pairingUrl?: string;
  lastError?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function previewUrls(record: WorkRecord): string[] {
  return record.previewPorts.map(
    (port) => `https://${port}-${record.sandboxId}.${record.sandboxDomain}`,
  );
}

function activity(
  record: WorkRecord,
  type: WorkRecord["activity"][number]["type"],
  detail: string,
): WorkRecord {
  const at = new Date().toISOString();
  return {
    ...record,
    updatedAt: at,
    lastActivityAt: at,
    activity: [...record.activity, { at, type, detail }].slice(-100),
  };
}

async function runChecked(
  sandbox: CubeSandboxHandle,
  command: string,
  options?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  const result = await sandbox.run(command, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(
      `Sandbox command failed with exit ${result.exitCode}: ${detail.slice(0, 1_000)}`,
    );
  }
  return result.stdout;
}

function gitRuntimeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["GH_TOKEN", "GITHUB_TOKEN"].flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
}

async function bootstrapSandbox(
  sandbox: CubeSandboxHandle,
  config: CubeProjectConfig,
): Promise<string> {
  const repository = shellQuote(config.project.repository);
  const remoteUrl = shellQuote(
    `https://github.com/${config.project.repository}.git`,
  );
  const workspacePath = shellQuote(config.project.workspacePath);
  const defaultRef = shellQuote(config.project.defaultRef);
  const cloneCommand = [
    "set -eu",
    `test ! -e ${workspacePath}`,
    `mkdir -p ${shellQuote(config.project.workspacePath.replace(/\/[^/]+$/, ""))}`,
    `if command -v gh >/dev/null 2>&1; then gh repo clone ${repository} ${workspacePath} -- --branch ${defaultRef}; else git clone --branch ${defaultRef} ${remoteUrl} ${workspacePath}; fi`,
  ].join("\n");
  await runChecked(sandbox, cloneCommand, { env: gitRuntimeEnvironment() });
  await runChecked(
    sandbox,
    "command -v paseo >/dev/null 2>&1 || npm install --global @getpaseo/cli@0.8.0",
  );
  await runChecked(sandbox, "paseo daemon start --json --timeout 120");
  const pairingOutput = await runChecked(
    sandbox,
    "paseo daemon pair --relay --json",
  );
  const parsed: unknown = JSON.parse(pairingOutput);
  return pairingOutputSchema.parse(parsed).url;
}

export class WorkService {
  private readonly remoteConnections = new Map<string, RemotePaseoConnection>();
  private readonly sandboxHandles = new Map<string, CubeSandboxHandle>();
  private readonly keepAliveTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly workOperationTails = new Map<string, Promise<void>>();
  private readonly boundRepositoryRoots = new Set<string>();
  private closing = false;

  constructor(
    private readonly records: WorkRecordStore,
    private readonly cube: CubeRuntime,
    private readonly paseo: RemotePaseoConnector,
  ) {}

  bindRepositoryRoot(repositoryRoot: string): void {
    this.boundRepositoryRoots.add(repositoryRoot);
  }

  canInitialize(): boolean {
    return this.boundRepositoryRoots.size === 1;
  }

  async start(): Promise<void> {
    for (const record of await this.records.list()) {
      if (record.status === "busy") this.scheduleKeepAlive(record, 0);
    }
  }

  async initializeBoundRepository(): Promise<string> {
    if (this.boundRepositoryRoots.size !== 1) {
      throw new Error(
        "Open exactly one project agent before initializing CubeSandbox configuration",
      );
    }
    return initializeProjectConfig([...this.boundRepositoryRoots][0]!);
  }

  async initializeRepository(repositoryRoot: string): Promise<string> {
    return initializeProjectConfig(repositoryRoot);
  }

  async createAgent(
    repositoryRoot: string,
    rawInput: CreateAgentInput,
  ): Promise<WorkSummary> {
    const input = createAgentInputSchema.parse(rawInput);
    if (input.workId) {
      return this.withWorkLock(input.workId, async () =>
        this.createAgentForRecord(
          repositoryRoot,
          input,
          await this.requireOwnedRecord(input.workId!, repositoryRoot),
        ),
      );
    }
    const record = await this.createWork(repositoryRoot, input);
    return this.withWorkLock(record.workId, () =>
      this.createAgentForRecord(repositoryRoot, input, record),
    );
  }

  private async createAgentForRecord(
    repositoryRoot: string,
    input: CreateAgentInput,
    record: WorkRecord,
  ): Promise<WorkSummary> {
    const readyRecord = await this.ensureReady(record);
    const config = await loadProjectConfig(repositoryRoot);
    const connection = await this.getRemoteConnection(readyRecord);
    const reference = await connection.createAgent({
      prompt: input.prompt,
      workspacePath: config.project.workspacePath,
      defaultRef: config.project.defaultRef,
      projectId: config.project.id,
      workId: readyRecord.workId,
      ordinal: readyRecord.agents.length + 1,
      provider: input.provider,
      model: input.model,
      mode: input.mode,
      thinking: input.thinking,
    });
    const createdAt = new Date().toISOString();
    const updated = activity(
      {
        ...readyRecord,
        status: "busy",
        agents: [...readyRecord.agents, { ...reference, createdAt }],
        pausedAt: undefined,
      },
      "agent-created",
      `Created remote agent ${reference.agentId}`,
    );
    try {
      await this.records.save(updated);
    } catch (persistError) {
      try {
        await connection.discardAgent(reference);
      } catch (cleanupError) {
        throw new AggregateError(
          [persistError, cleanupError],
          "Remote agent was created, but local persistence and remote cleanup both failed",
        );
      }
      throw persistError;
    }
    this.scheduleKeepAlive(updated);
    return this.summary(updated, true);
  }

  async sendPrompt(
    repositoryRoot: string,
    input: { workId: string; prompt: string; agentId?: string },
  ): Promise<WorkSummary> {
    const parsed = z
      .object({
        workId: z.string().uuid(),
        prompt: z.string().min(1),
        agentId: z.string().min(1).optional(),
      })
      .strict()
      .parse(input);
    return this.withWorkLock(parsed.workId, async () => {
      const record = await this.ensureReady(
        await this.requireOwnedRecord(parsed.workId, repositoryRoot),
      );
      const agentId = parsed.agentId ?? record.agents.at(-1)?.agentId;
      if (
        !agentId ||
        !record.agents.some((agent) => agent.agentId === agentId)
      ) {
        throw new Error("Work Sandbox has no matching managed agent");
      }
      await (
        await this.getRemoteConnection(record)
      ).sendPrompt(agentId, parsed.prompt);
      const updated = activity(
        { ...record, status: "busy", pausedAt: undefined },
        "prompt-sent",
        `Sent prompt to ${agentId}`,
      );
      await this.records.save(updated);
      this.scheduleKeepAlive(updated);
      return this.summary(updated, false);
    });
  }

  async getStatus(
    repositoryRoot: string,
    workId: string,
  ): Promise<WorkSummary> {
    return this.withWorkLock(workId, async () => {
      const record = await this.refreshStatus(
        await this.requireOwnedRecord(workId, repositoryRoot),
      );
      return this.summary(record, false);
    });
  }

  async getActivity(repositoryRoot: string, workId: string, limit = 20) {
    const record = await this.requireOwnedRecord(workId, repositoryRoot);
    return record.activity.slice(-Math.max(1, Math.min(limit, 100))).reverse();
  }

  async list(
    repositoryRoot?: string,
    includePairing = false,
  ): Promise<WorkSummary[]> {
    return Promise.all(
      (await this.records.list(repositoryRoot)).map(async (record) =>
        this.withWorkLock(record.workId, async () =>
          this.summary(await this.refreshStatus(record), includePairing),
        ),
      ),
    );
  }

  async pause(
    repositoryRoot: string | undefined,
    workId: string,
  ): Promise<WorkSummary> {
    return this.withWorkLock(workId, async () => {
      this.stopKeepAlive(workId);
      const record = repositoryRoot
        ? await this.requireOwnedRecord(workId, repositoryRoot)
        : await this.records.get(workId);
      const config = await loadProjectConfig(record.repositoryRoot);
      const pausing = { ...record, status: "pausing" as const };
      await this.records.save(pausing);
      await this.cube.pause(config, record.sandboxId);
      this.sandboxHandles.delete(workId);
      await this.closeRemoteConnection(record.workId);
      const pausedAt = new Date().toISOString();
      const paused = activity(
        { ...pausing, status: "paused", pausedAt },
        "paused",
        "Paused Work Sandbox",
      );
      await this.records.save(paused);
      return this.summary(paused, repositoryRoot === undefined);
    });
  }

  async resume(
    repositoryRoot: string | undefined,
    workId: string,
  ): Promise<WorkSummary> {
    return this.withWorkLock(workId, async () => {
      const record = repositoryRoot
        ? await this.requireOwnedRecord(workId, repositoryRoot)
        : await this.records.get(workId);
      const resumed = await this.ensureReady(record);
      return this.summary(resumed, repositoryRoot === undefined);
    });
  }

  async destroy(
    repositoryRoot: string | undefined,
    workId: string,
  ): Promise<void> {
    await this.withWorkLock(workId, async () => {
      this.stopKeepAlive(workId);
      const record = repositoryRoot
        ? await this.requireOwnedRecord(workId, repositoryRoot)
        : await this.records.get(workId);
      const config = await loadProjectConfig(record.repositoryRoot);
      await this.cube.destroy(config, record.sandboxId);
      this.sandboxHandles.delete(workId);
      await this.closeRemoteConnection(workId);
      await this.records.remove(workId);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const workId of this.keepAliveTimers.keys()) {
      this.stopKeepAlive(workId);
    }
    await Promise.allSettled(this.workOperationTails.values());
    this.sandboxHandles.clear();
    await Promise.all(
      [...this.remoteConnections.keys()].map((workId) =>
        this.closeRemoteConnection(workId),
      ),
    );
  }

  private async createWork(
    repositoryRoot: string,
    input: CreateAgentInput,
  ): Promise<WorkRecord> {
    const config = await loadProjectConfig(repositoryRoot);
    const workId = randomUUID();
    const sandbox = await this.cube.create(config, workId);
    this.sandboxHandles.set(workId, sandbox);
    const timestamp = new Date().toISOString();
    let record: WorkRecord = {
      version: 1,
      workId,
      sandboxId: sandbox.sandboxId,
      repositoryRoot,
      projectId: config.project.id,
      repository: config.project.repository,
      sandboxDomain: config.cube.sandboxDomain,
      previewPorts: config.sandbox.previewPorts,
      idleTimeoutSeconds: config.sandbox.idleTimeoutSeconds,
      task: input.task,
      agents: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
      status: "creating",
      activity: [
        { at: timestamp, type: "created", detail: "Created Work Sandbox" },
      ],
    };
    await this.records.save(record);
    try {
      const pairingUrl = await bootstrapSandbox(sandbox, config);
      await this.records.saveSecrets(workId, { pairingUrl });
      const connection = await this.paseo.connect(pairingUrl);
      this.remoteConnections.set(workId, connection);
      record = {
        ...record,
        relay: { serverId: connection.serverId },
        status: "ready",
      };
      await this.records.save(record);
      return record;
    } catch (error) {
      const failed = activity(
        {
          ...record,
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        },
        "error",
        "Sandbox bootstrap failed",
      );
      await this.records.save(failed);
      throw error;
    }
  }

  private async ensureReady(record: WorkRecord): Promise<WorkRecord> {
    if (record.status === "error")
      throw new Error(record.lastError ?? "Work Sandbox is in error state");
    const config = await loadProjectConfig(record.repositoryRoot);
    const info = await this.cube.inspect(config, record.sandboxId);
    if (info.state !== "paused") {
      await this.getRemoteConnection(record);
      if (record.status === "busy") this.scheduleKeepAlive(record);
      return record;
    }
    await this.records.save({ ...record, status: "resuming" });
    const sandbox = await this.cube.connect(config, record.sandboxId);
    this.sandboxHandles.set(record.workId, sandbox);
    await this.getRemoteConnection(record, true);
    const resumed = activity(
      { ...record, status: "ready", pausedAt: undefined, lastError: undefined },
      "resumed",
      "Resumed Work Sandbox",
    );
    await this.records.save(resumed);
    return resumed;
  }

  private async refreshStatus(record: WorkRecord): Promise<WorkRecord> {
    if (record.status === "creating" || record.status === "error")
      return record;
    const config = await loadProjectConfig(record.repositoryRoot);
    try {
      const info = await this.cube.inspect(config, record.sandboxId);
      if (info.state === "paused") {
        this.stopKeepAlive(record.workId);
        this.sandboxHandles.delete(record.workId);
        await this.closeRemoteConnection(record.workId);
        if (record.status === "paused") return record;
        const paused = activity(
          {
            ...record,
            status: "paused",
            pausedAt: new Date().toISOString(),
          },
          "paused",
          "Cube idle timeout paused Work Sandbox",
        );
        await this.records.save(paused);
        return paused;
      }
      const status = await this.remoteStatus(record);
      if (status === "busy") {
        this.scheduleKeepAlive({ ...record, status });
      } else {
        if (record.status === "busy") {
          await (await this.getSandboxHandle(config, record)).keepAlive();
        }
        this.stopKeepAlive(record.workId);
      }
      if (status === record.status) return record;
      const updated = {
        ...record,
        status,
        pausedAt: undefined,
        updatedAt: new Date().toISOString(),
      } as WorkRecord;
      await this.records.save(updated);
      return updated;
    } catch {
      return record;
    }
  }

  private async remoteStatus(record: WorkRecord): Promise<"busy" | "ready"> {
    if (record.agents.length === 0) return "ready";
    const connection = await this.getRemoteConnection(record);
    return (await connection.hasBusyAgent(
      record.agents.map((agent) => agent.agentId),
    ))
      ? "busy"
      : "ready";
  }

  private keepAliveInterval(record: WorkRecord): number {
    return Math.max(
      250,
      Math.min(60_000, Math.floor((record.idleTimeoutSeconds * 1_000) / 3)),
    );
  }

  private scheduleKeepAlive(record: WorkRecord, delay?: number): void {
    if (this.closing || record.status !== "busy") return;
    if (this.keepAliveTimers.has(record.workId)) return;
    const timer = setTimeout(
      async () => {
        this.keepAliveTimers.delete(record.workId);
        await this.withWorkLock(record.workId, () =>
          this.runKeepAliveCheck(record.workId),
        ).catch(async () => {
          console.warn("CubeSandbox keepalive check failed; retrying");
          if (this.closing) return;
          const current = await this.records
            .get(record.workId)
            .catch(() => null);
          if (current?.status === "busy") {
            this.scheduleKeepAlive(current, this.keepAliveInterval(current));
          }
        });
      },
      delay ?? this.keepAliveInterval(record),
    );
    this.keepAliveTimers.set(record.workId, timer);
  }

  private stopKeepAlive(workId: string): void {
    const timer = this.keepAliveTimers.get(workId);
    if (timer) clearTimeout(timer);
    this.keepAliveTimers.delete(workId);
  }

  private async runKeepAliveCheck(workId: string): Promise<void> {
    if (this.closing) return;
    const record = await this.records.get(workId);
    if (record.status !== "busy") return;
    const config = await loadProjectConfig(record.repositoryRoot);
    const info = await this.cube.inspect(config, record.sandboxId);
    if (info.state === "paused") {
      this.sandboxHandles.delete(workId);
      await this.closeRemoteConnection(workId);
      const paused = activity(
        {
          ...record,
          status: "paused",
          pausedAt: new Date().toISOString(),
        },
        "paused",
        "Cube idle timeout paused Work Sandbox",
      );
      await this.records.save(paused);
      return;
    }

    await (await this.getSandboxHandle(config, record)).keepAlive();
    if ((await this.remoteStatus(record)) === "busy") {
      this.scheduleKeepAlive(record);
      return;
    }

    const ready = {
      ...record,
      status: "ready" as const,
      pausedAt: undefined,
      updatedAt: new Date().toISOString(),
    };
    await this.records.save(ready);
  }

  private async getSandboxHandle(
    config: CubeProjectConfig,
    record: WorkRecord,
  ): Promise<CubeSandboxHandle> {
    const existing = this.sandboxHandles.get(record.workId);
    if (existing) return existing;
    const sandbox = await this.cube.connect(config, record.sandboxId);
    this.sandboxHandles.set(record.workId, sandbox);
    return sandbox;
  }

  private async withWorkLock<T>(
    workId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.workOperationTails.get(workId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.workOperationTails.set(workId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.workOperationTails.get(workId) === current) {
        this.workOperationTails.delete(workId);
      }
    }
  }

  private async requireOwnedRecord(
    workId: string,
    repositoryRoot: string,
  ): Promise<WorkRecord> {
    const record = await this.records.get(workId);
    if (record.repositoryRoot !== repositoryRoot) {
      throw new Error(
        "Work Sandbox is not owned by this repository capability",
      );
    }
    return record;
  }

  private async getRemoteConnection(
    record: WorkRecord,
    replace = false,
  ): Promise<RemotePaseoConnection> {
    if (replace) await this.closeRemoteConnection(record.workId);
    const existing = this.remoteConnections.get(record.workId);
    if (existing) return existing;
    const { pairingUrl } = await this.records.getSecrets(record.workId);
    const connection = await this.paseo.connect(pairingUrl);
    this.remoteConnections.set(record.workId, connection);
    return connection;
  }

  private async closeRemoteConnection(workId: string): Promise<void> {
    const connection = this.remoteConnections.get(workId);
    this.remoteConnections.delete(workId);
    await connection?.close().catch(() => undefined);
  }

  private async summary(
    record: WorkRecord,
    includePairing: boolean,
  ): Promise<WorkSummary> {
    let pairingUrl: string | undefined;
    if (includePairing && record.relay) {
      pairingUrl = (await this.records.getSecrets(record.workId)).pairingUrl;
    }
    return workSummarySchema.parse({
      workId: record.workId,
      sandboxId: record.sandboxId,
      projectId: record.projectId,
      repository: record.repository,
      status: record.status,
      idleTimeoutSeconds: record.idleTimeoutSeconds,
      updatedAt: record.updatedAt,
      pausedAt: record.pausedAt,
      worktreeCount: record.agents.length,
      agentCount: record.agents.length,
      agents: record.agents,
      previewUrls: previewUrls(record),
      pairingUrl,
      lastError: record.lastError,
    });
  }
}
