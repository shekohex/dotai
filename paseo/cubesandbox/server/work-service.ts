import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { CubeProjectConfig } from "../shared/config.js";
import {
  cubeProjectSummarySchema,
  workStatusSchema,
  workSummarySchema,
} from "../shared/contracts.js";
import {
  sandboxRuntimeEnvironment,
  type CubeRuntime,
  type CubeCommandOptions,
  type CubeSandboxHandle,
} from "./cube-runtime.js";
import {
  initializeProjectConfigAtProjectRoot,
  loadProjectConfig,
} from "./project-config.js";
import {
  LEGACY_PROJECT_PREFIX,
  matchScopeForRecord,
  type ProjectScope,
  UNASSIGNED_PROJECT_ID,
} from "./project-registry.js";
import {
  type RemoteAgentTimeline,
  type RemoteAgentTimelineOptions,
  type RemoteAgentReference,
  type RemotePaseoConnection,
  type RemotePaseoConnector,
} from "./remote-paseo.js";
import type { RuntimeIdentityBundle } from "./runtime-identity.js";
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
    modeId: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
    featureValues: z.record(z.string(), z.json()).optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .refine(Number.isSafeInteger, "must be a safe integer")
      .optional(),
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

/** A project-bound owner. Both identity fields are required for resource mutations. */
export interface WorkOwner {
  paseoProjectId: string;
  paseoWorkspaceId?: string;
  canonicalRoot: string;
}

export function workOwnerForScope(scope: ProjectScope): WorkOwner {
  return {
    paseoProjectId: scope.projectId,
    ...(scope.workspaceId ? { paseoWorkspaceId: scope.workspaceId } : {}),
    canonicalRoot: scope.canonicalRoot,
  };
}

function workOwnerForRecord(record: WorkRecord): WorkOwner {
  return {
    paseoProjectId: record.paseoProjectId ?? "",
    ...(record.paseoWorkspaceId
      ? { paseoWorkspaceId: record.paseoWorkspaceId }
      : {}),
    canonicalRoot: record.repositoryRoot,
  };
}

export type CubeProjectSummary = z.infer<typeof cubeProjectSummarySchema>;

export interface WorkSummary {
  workId: string;
  sandboxId: string;
  paseoProjectId: string;
  cubeProjectId: string;
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
  quarantined?: boolean;
}

export interface GetActivityInput {
  workId: string;
  agentId?: string;
  limit?: number;
  cursor?: RemoteAgentTimelineOptions["cursor"];
  direction?: RemoteAgentTimelineOptions["direction"];
}

type WorkServiceLifecycle = "accepting" | "closing" | "closed";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingConfigError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
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

function countWorks(
  works: readonly WorkSummary[],
): CubeProjectSummary["counts"] {
  return {
    work: works.length,
    busy: works.filter((work) => work.status === "busy").length,
    paused: works.filter((work) => work.status === "paused").length,
  };
}

function isQuarantinedRecord(record: WorkRecord): boolean {
  if (record.ownershipStatus === "quarantined") return true;
  const projectId = record.paseoProjectId;
  return !projectId || projectId.startsWith(LEGACY_PROJECT_PREFIX);
}

function pushGroup(
  groups: Map<string, WorkRecord[]>,
  key: string,
  record: WorkRecord,
): void {
  const group = groups.get(key) ?? [];
  group.push(record);
  groups.set(key, group);
}

async function runChecked(
  sandbox: CubeSandboxHandle,
  command: string,
  options?: CubeCommandOptions,
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

async function bootstrapSandbox(
  sandbox: CubeSandboxHandle,
  config: CubeProjectConfig,
  repositoryRoot: string,
  loadRuntimeIdentityBundle: (
    repositoryRoot: string,
  ) => Promise<RuntimeIdentityBundle>,
  timeoutMs?: number,
): Promise<string> {
  const remoteUrl = shellQuote(
    `git@github.com:${config.project.repository}.git`,
  );
  const httpsRemoteUrl = shellQuote(
    `https://github.com/${config.project.repository}.git`,
  );
  const workspacePath = shellQuote(config.project.workspacePath);
  const defaultRef = shellQuote(config.project.defaultRef);
  const runtimeIdentity = await loadRuntimeIdentityBundle(repositoryRoot);
  const runtimeDirectories = [
    ...new Set([
      "/home/coder/.ssh",
      ...runtimeIdentity.files.map((file) =>
        file.destination.replace(/\/[^/]+$/, ""),
      ),
    ]),
  ].sort((left, right) => left.length - right.length);
  const bootstrapCommandOptions =
    timeoutMs === undefined ? undefined : { timeoutMs };
  await runChecked(
    sandbox,
    [
      "set -euo pipefail",
      `install -d -m 0700 ${runtimeDirectories.map(shellQuote).join(" ")}`,
      ...runtimeIdentity.files.map(
        (file) =>
          `install -m ${file.mode.toString(8).padStart(4, "0")} /dev/null ${shellQuote(file.destination)}`,
      ),
    ].join("\n"),
    bootstrapCommandOptions,
  );
  for (const { destination, contents } of runtimeIdentity.files) {
    await sandbox.writeFile(destination, contents);
  }
  await runChecked(
    sandbox,
    [
      "set -euo pipefail",
      ...runtimeIdentity.files.map(
        (file) =>
          `chmod ${file.mode.toString(8).padStart(4, "0")} ${shellQuote(file.destination)}`,
      ),
      `git config --global user.name ${shellQuote(runtimeIdentity.git.userName)}`,
      `git config --global user.email ${shellQuote(runtimeIdentity.git.userEmail)}`,
      "git config --global gpg.format ssh",
      "git config --global commit.gpgsign true",
      `git config --global user.signingkey ${shellQuote(runtimeIdentity.git.signingKeyPath)}`,
      ...(runtimeIdentity.git.knownHostsPath
        ? [
            `git config --global core.sshCommand ${shellQuote(
              `ssh -i ${runtimeIdentity.git.authKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${runtimeIdentity.git.knownHostsPath}`,
            )}`,
          ]
        : []),
      ...runtimeIdentity.files.map(
        (file) =>
          `test "$(stat -c %a ${shellQuote(file.destination)})" = ${file.mode.toString(8)}`,
      ),
    ].join("\n"),
    bootstrapCommandOptions,
  );
  const cloneCommand = [
    "set -euo pipefail",
    `test ! -e ${workspacePath}`,
    `mkdir -p ${shellQuote(config.project.workspacePath.replace(/\/[^/]+$/, ""))}`,
    `if command -v gh >/dev/null 2>&1 && { test -n "\${GH_TOKEN:-}" || test -n "\${GITHUB_TOKEN:-}"; }; then`,
    `  gh repo clone ${httpsRemoteUrl} ${workspacePath} -- --branch ${defaultRef}`,
    `  cd ${workspacePath}`,
    "  gh auth setup-git",
    `elif { test -z "\${GH_TOKEN:-}" && test -z "\${GITHUB_TOKEN:-}"; }; then`,
    `  git clone --branch ${defaultRef} ${remoteUrl} ${workspacePath}`,
    "else",
    '  echo "GitHub CLI is required for token-backed clone" >&2',
    "  exit 1",
    "fi",
    `cd ${workspacePath}`,
    "./install.sh --yes",
    "sed -i 's#/home/coder/dotai#/workspace/dotai#g' /home/coder/.codex/config.toml",
    `npm ci --prefix ${workspacePath}/agent`,
    "test ! -e /home/coder/.config/gh/hosts.yml",
  ].join("\n");
  const runtimeEnvironment = sandboxRuntimeEnvironment(process.env);
  delete runtimeEnvironment.GH_TOKEN;
  delete runtimeEnvironment.GITHUB_TOKEN;
  const githubEnvironment = runtimeIdentity.githubToken
    ? { GH_TOKEN: runtimeIdentity.githubToken }
    : {};
  if (runtimeIdentity.githubToken) {
    runtimeEnvironment.GH_TOKEN = runtimeIdentity.githubToken;
  }
  await runChecked(sandbox, cloneCommand, {
    env: githubEnvironment,
    ...bootstrapCommandOptions,
  });
  await runChecked(
    sandbox,
    "command -v paseo >/dev/null 2>&1 || bun add --global @getpaseo/cli@0.8.0",
    bootstrapCommandOptions,
  );
  await runChecked(sandbox, "paseo daemon start --json", {
    env: runtimeEnvironment,
    ...bootstrapCommandOptions,
  });
  const pairingOutput = await runChecked(
    sandbox,
    "paseo daemon pair --relay --json",
    bootstrapCommandOptions,
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
  private readonly unkeyedOperations = new Set<Promise<unknown>>();
  private readonly shutdownCleanupFailures: unknown[] = [];
  private lifecycle: WorkServiceLifecycle = "accepting";
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly records: WorkRecordStore,
    private readonly cube: CubeRuntime,
    private readonly paseo: RemotePaseoConnector,
    private readonly loadRuntimeIdentityBundle: (
      repositoryRoot: string,
    ) => Promise<RuntimeIdentityBundle>,
  ) {}

  async start(): Promise<void> {
    this.assertAccepting();
    for (const record of await this.records.list()) {
      if (record.status === "busy") this.scheduleKeepAlive(record, 0);
    }
  }

  /** Creates `.cube/config.json` for exactly one registered project root. */
  initializeConfig(canonicalRoot: string): Promise<string> {
    return this.trackUnkeyedOperation(() =>
      initializeProjectConfigAtProjectRoot(canonicalRoot),
    );
  }

  getRecord(workId: string): Promise<WorkRecord> {
    return this.records.get(workId);
  }

  async createAgent(
    owner: WorkOwner,
    rawInput: CreateAgentInput,
  ): Promise<WorkSummary> {
    this.assertAccepting();
    const input = createAgentInputSchema.parse(rawInput);
    if (input.workId) {
      return this.withWorkLock(input.workId, async () =>
        this.createAgentForRecord(
          owner,
          input,
          await this.requireOwnedRecord(owner, input.workId!),
        ),
      );
    }
    const workId = randomUUID();
    return this.withWorkLock(workId, async () => {
      const record = await this.createWork(owner, input, workId);
      try {
        const summary = await this.createAgentForRecord(owner, input, record);
        this.assertAccepting();
        return summary;
      } catch (error) {
        if (this.lifecycle === "accepting") throw error;
        if (error instanceof AggregateError) {
          this.shutdownCleanupFailures.push(error);
        }
        await this.cleanupCreatingWork(record.workId, error);
        throw this.lifecycleError();
      }
    });
  }

  private async createAgentForRecord(
    owner: WorkOwner,
    input: CreateAgentInput,
    record: WorkRecord,
  ): Promise<WorkSummary> {
    const readyRecord = await this.ensureReady(record);
    const config = await loadProjectConfig(owner.canonicalRoot);
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
      modeId: input.modeId,
      thinkingOptionId: input.thinkingOptionId,
      featureValues: input.featureValues,
    });
    try {
      this.assertAccepting();
    } catch (error) {
      await this.discardRemoteAgent(connection, reference, error);
      throw error;
    }
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
    let persisted = false;
    try {
      await this.records.save(updated);
      persisted = true;
      this.assertAccepting();
    } catch (persistError) {
      const cleanupErrors: unknown[] = [];
      try {
        await connection.discardAgent(reference);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (persisted) {
        try {
          await this.records.save(readyRecord);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [persistError, ...cleanupErrors],
          "Remote agent cleanup failed after local persistence did not complete safely",
        );
      }
      throw persistError;
    }
    this.scheduleKeepAlive(updated);
    return this.summary(updated, true);
  }

  async sendPrompt(
    owner: WorkOwner,
    input: { workId: string; prompt: string; agentId?: string },
  ): Promise<WorkSummary> {
    this.assertAccepting();
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
        await this.requireOwnedRecord(owner, parsed.workId),
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

  async getStatus(owner: WorkOwner, workId: string): Promise<WorkSummary> {
    this.assertAccepting();
    return this.withWorkLock(workId, async () => {
      const record = await this.refreshStatus(
        await this.requireOwnedRecord(owner, workId),
      );
      return this.summary(record, false);
    });
  }

  getWorkEvents(
    owner: WorkOwner,
    workId: string,
    limit = 20,
  ): Promise<WorkRecord["activity"]> {
    return this.trackUnkeyedOperation(async () => {
      const record = await this.requireOwnedRecord(owner, workId);
      return record.activity
        .slice(-Math.max(1, Math.min(limit, 100)))
        .reverse();
    });
  }

  getActivity(
    owner: WorkOwner,
    input: GetActivityInput,
  ): Promise<RemoteAgentTimeline & { workId: string; workspaceId: string }> {
    return this.trackUnkeyedOperation(async () => {
      const record = await this.requireOwnedRecord(owner, input.workId);
      const agent = input.agentId
        ? record.agents.find((entry) => entry.agentId === input.agentId)
        : record.agents.at(-1);
      if (!agent) {
        throw new Error("Work Sandbox has no matching managed agent");
      }
      const timeline = await (
        await this.getRemoteConnection(record)
      ).getAgentTimeline(agent.agentId, {
        ...(input.direction ? { direction: input.direction } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        projection: "projected",
      });
      return {
        ...timeline,
        workId: input.workId,
        workspaceId: agent.workspaceId,
      };
    });
  }

  list(owner?: WorkOwner, includePairing = false): Promise<WorkSummary[]> {
    return this.trackUnkeyedOperation(async () => {
      const records = await this.records.list(owner?.canonicalRoot);
      return Promise.all(
        records
          .filter(
            (record) =>
              owner === undefined ||
              (record.paseoProjectId === owner.paseoProjectId &&
                record.paseoWorkspaceId === owner.paseoWorkspaceId),
          )
          .map(async (record) =>
            this.withWorkLock(record.workId, async () =>
              this.summary(await this.refreshStatus(record), includePairing),
            ),
          ),
      );
    });
  }

  /**
   * Authoritative, project-grouped inventory for the UI. Requires no capability
   * binding, so it survives plugin reload and existing-agent recreation.
   */
  projectSummaries(
    scopes: readonly ProjectScope[],
    includePairing = false,
  ): Promise<CubeProjectSummary[]> {
    return this.trackUnkeyedOperation(async () => {
      const records = await this.records.list();
      const projectScopes = scopes.filter(
        (scope) => scope.workspaceId === undefined,
      );
      const scopeIds = new Set(projectScopes.map((scope) => scope.projectId));
      const scopeWorks = new Map<string, WorkRecord[]>();
      const removedWorks = new Map<string, WorkRecord[]>();
      const unassigned: WorkRecord[] = [];
      for (const record of records) {
        const projectId = record.paseoProjectId;
        if (isQuarantinedRecord(record)) {
          unassigned.push(record);
          continue;
        }
        const scope = matchScopeForRecord(scopes, record);
        if (!scope) {
          if (scopeIds.has(projectId!)) unassigned.push(record);
          else pushGroup(removedWorks, projectId!, record);
          continue;
        }
        if (!scopeIds.has(projectId!)) {
          pushGroup(removedWorks, projectId!, record);
          continue;
        }
        pushGroup(scopeWorks, projectId!, record);
      }
      const summaries: CubeProjectSummary[] = [];
      for (const scope of projectScopes) {
        summaries.push(
          await this.buildScopeSummary(
            scope,
            scopeWorks.get(scope.projectId) ?? [],
            includePairing,
          ),
        );
      }
      for (const [projectId, works] of removedWorks) {
        if (scopeIds.has(projectId)) continue;
        const removedSummaries = await this.summarizeRecords(
          works,
          includePairing,
        );
        summaries.push({
          projectId,
          displayName: `Removed project ${projectId}`,
          availability: "removed",
          configStatus: "unavailable",
          canonicalRoot: works[0]?.repositoryRoot,
          counts: countWorks(removedSummaries),
          works: removedSummaries,
        });
      }
      if (unassigned.length > 0) {
        const works = await this.summarizeRecords(unassigned, includePairing);
        summaries.push({
          projectId: UNASSIGNED_PROJECT_ID,
          displayName: "Unassigned work records",
          availability: "removed",
          configStatus: "unavailable",
          counts: countWorks(works),
          works,
        });
      }
      return summaries;
    });
  }

  /**
   * Resolves a UI mutation target to an owner. Unknown projects, unavailable
   * scopes, and unsupported removed-project operations fail before any
   * filesystem or resource mutation.
   */
  async resolveWorkOwner(
    scopes: readonly ProjectScope[],
    projectId: string,
    workId: string,
    options?: { allowRemoved?: boolean },
  ): Promise<WorkOwner> {
    if (projectId === UNASSIGNED_PROJECT_ID) {
      const record = await this.records.get(workId);
      if (!isQuarantinedRecord(record)) {
        throw new Error("Work Sandbox is not an unassigned record: " + workId);
      }
      return workOwnerForRecord(record);
    }
    const record = await this.records.get(workId);
    if (record.paseoProjectId !== projectId) {
      throw new Error(`Unknown Paseo project: ${projectId}`);
    }
    const scope = matchScopeForRecord(scopes, record);
    if (scope) {
      if (scope.availability === "online") return workOwnerForScope(scope);
      if (!options?.allowRemoved) {
        throw new Error(
          scope.error ??
            `Paseo workspace is ${scope.availability}: ${projectId}`,
        );
      }
      return workOwnerForRecord(record);
    }
    const projectScope = scopes.find(
      (candidate) =>
        candidate.projectId === projectId &&
        candidate.workspaceId === undefined,
    );
    if (projectScope) {
      throw new Error("Work Sandbox is not owned by this project capability");
    }
    if (!options?.allowRemoved) {
      throw new Error(`Unknown Paseo project: ${projectId}`);
    }
    return workOwnerForRecord(record);
  }

  async pause(owner: WorkOwner, workId: string): Promise<WorkSummary> {
    this.assertAccepting();
    return this.withWorkLock(workId, async () => {
      const record = await this.requireOwnedRecord(owner, workId);
      this.stopKeepAlive(workId);
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
      return this.summary(paused, false);
    });
  }

  async resume(owner: WorkOwner, workId: string): Promise<WorkSummary> {
    this.assertAccepting();
    return this.withWorkLock(workId, async () => {
      const record = await this.requireOwnedRecord(owner, workId);
      const resumed = await this.ensureReady(record);
      return this.summary(resumed, false);
    });
  }

  async destroy(owner: WorkOwner, workId: string): Promise<void> {
    this.assertAccepting();
    await this.withWorkLock(workId, async () => {
      const record = await this.requireOwnedRecord(owner, workId);
      this.stopKeepAlive(workId);
      const config = await loadProjectConfig(record.repositoryRoot);
      try {
        await this.cube.destroy(config, record.sandboxId);
      } catch (error) {
        try {
          await this.saveCleanupError(record, error);
        } catch (persistenceError) {
          throw new AggregateError(
            [error, persistenceError],
            "Sandbox destruction failed and cleanup ownership could not be persisted",
          );
        }
        throw error;
      }
      this.sandboxHandles.delete(workId);
      await this.closeRemoteConnection(workId);
      await this.records.remove(workId);
    });
  }

  beginClosing(): void {
    if (this.lifecycle === "accepting") this.lifecycle = "closing";
  }

  close(): Promise<void> {
    this.beginClosing();
    this.closePromise ??= this.closeResources().finally(() => {
      this.lifecycle = "closed";
    });
    return this.closePromise;
  }

  private async buildScopeSummary(
    scope: ProjectScope,
    records: WorkRecord[],
    includePairing: boolean,
  ): Promise<CubeProjectSummary> {
    const works = await this.summarizeRecords(records, includePairing);
    return {
      projectId: scope.projectId,
      displayName: scope.displayName,
      availability: scope.availability,
      canonicalRoot: scope.canonicalRoot,
      ...(await this.configState(scope)),
      counts: countWorks(works),
      works,
    };
  }

  private async configState(
    scope: ProjectScope,
  ): Promise<
    Pick<
      CubeProjectSummary,
      "configStatus" | "cubeProjectId" | "repository" | "configError"
    >
  > {
    if (scope.availability !== "online") {
      return { configStatus: "unavailable" };
    }
    try {
      const config = await loadProjectConfig(scope.canonicalRoot);
      return {
        configStatus: "ready",
        cubeProjectId: config.project.id,
        repository: config.project.repository,
      };
    } catch (error) {
      if (isMissingConfigError(error)) return { configStatus: "missing" };
      return { configStatus: "invalid", configError: errorMessage(error) };
    }
  }

  private summarizeRecords(
    records: readonly WorkRecord[],
    includePairing: boolean,
  ): Promise<WorkSummary[]> {
    return Promise.all(
      records.map(async (record) =>
        this.withWorkLock(record.workId, async () =>
          this.summary(await this.refreshStatus(record), includePairing),
        ),
      ),
    );
  }

  private async closeResources(): Promise<void> {
    for (const workId of this.keepAliveTimers.keys()) {
      this.stopKeepAlive(workId);
    }
    await Promise.allSettled([
      ...this.unkeyedOperations,
      ...this.workOperationTails.values(),
    ]);
    this.sandboxHandles.clear();
    const results = await Promise.allSettled(
      [...this.remoteConnections.keys()].map((workId) =>
        this.closeRemoteConnection(workId, false),
      ),
    );
    const failures = [
      ...this.shutdownCleanupFailures,
      ...results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    ];
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "CubeSandbox WorkService cleanup failed",
      );
    }
  }

  private async createWork(
    owner: WorkOwner,
    input: CreateAgentInput,
    workId: string,
  ): Promise<WorkRecord> {
    const config = await loadProjectConfig(owner.canonicalRoot);
    this.assertAccepting();
    let sandbox: CubeSandboxHandle | undefined;
    let record: WorkRecord | undefined;
    try {
      sandbox = await this.cube.create(config, workId);
      this.assertAccepting();
      this.sandboxHandles.set(workId, sandbox);
      const timestamp = new Date().toISOString();
      record = {
        version: 2,
        workId,
        sandboxId: sandbox.sandboxId,
        repositoryRoot: owner.canonicalRoot,
        projectId: config.project.id,
        cubeProjectId: config.project.id,
        paseoProjectId: owner.paseoProjectId,
        ...(owner.paseoWorkspaceId
          ? { paseoWorkspaceId: owner.paseoWorkspaceId }
          : {}),
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
        ownershipStatus: "active",
        activity: [
          { at: timestamp, type: "created", detail: "Created Work Sandbox" },
        ],
      };
      await this.records.save(record);
      this.assertAccepting();
      const pairingUrl = await bootstrapSandbox(
        sandbox,
        config,
        owner.canonicalRoot,
        this.loadRuntimeIdentityBundle,
        input.timeoutMs,
      );
      this.assertAccepting();
      await this.records.saveSecrets(workId, { pairingUrl });
      this.assertAccepting();
      const connection = await this.paseo.connect(pairingUrl);
      this.remoteConnections.set(workId, connection);
      this.assertAccepting();
      record = {
        ...record,
        relay: { serverId: connection.serverId },
        status: "ready",
      };
      await this.records.save(record);
      this.assertAccepting();
      return record;
    } catch (error) {
      if (this.lifecycle !== "accepting") {
        if (sandbox) await this.cleanupCreatingWork(workId, error, sandbox);
        throw this.lifecycleError();
      }
      if (!record) throw error;
      if (sandbox) {
        await this.cleanupCreatingWork(workId, error, sandbox);
      }
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
    try {
      const config = await loadProjectConfig(record.repositoryRoot);
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
    if (this.lifecycle !== "accepting" || record.status !== "busy") return;
    if (this.keepAliveTimers.has(record.workId)) return;
    const timer = setTimeout(
      async () => {
        this.keepAliveTimers.delete(record.workId);
        await this.withWorkLock(record.workId, () =>
          this.runKeepAliveCheck(record.workId),
        ).catch(async () => {
          console.warn("CubeSandbox keepalive check failed; retrying");
          if (this.lifecycle !== "accepting") return;
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
    if (this.lifecycle !== "accepting") return;
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

  private trackUnkeyedOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertAccepting();
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const tracked = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.unkeyedOperations.add(tracked);
    void Promise.resolve()
      .then(() => {
        this.assertAccepting();
        return operation();
      })
      .then(resolve, reject);
    void tracked.then(
      () => this.unkeyedOperations.delete(tracked),
      () => this.unkeyedOperations.delete(tracked),
    );
    return tracked;
  }

  private assertAccepting(): void {
    if (this.lifecycle !== "accepting") throw this.lifecycleError();
  }

  private lifecycleError(): Error {
    return new Error(`CubeSandbox service is ${this.lifecycle}`);
  }

  private async discardRemoteAgent(
    connection: RemotePaseoConnection,
    reference: RemoteAgentReference,
    cause: unknown,
  ): Promise<void> {
    try {
      await connection.discardAgent(reference);
    } catch (cleanupError) {
      throw new AggregateError(
        [cause, cleanupError],
        "Remote agent was created during shutdown and could not be discarded",
      );
    }
  }

  private async cleanupCreatingWork(
    workId: string,
    cause: unknown,
    providedSandbox?: CubeSandboxHandle,
  ): Promise<void> {
    this.stopKeepAlive(workId);
    const sandbox = providedSandbox ?? this.sandboxHandles.get(workId);
    const connection = this.remoteConnections.get(workId);
    this.remoteConnections.delete(workId);
    const results = await Promise.allSettled([
      connection?.close(),
      sandbox?.destroy(),
    ]);
    const destroyResult = results[1];
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    try {
      if (!sandbox || destroyResult?.status === "fulfilled") {
        this.sandboxHandles.delete(workId);
        await this.records.remove(workId);
      } else {
        const record = await this.records.get(workId);
        await this.saveCleanupError(record, destroyResult.reason);
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      const cleanupError = new AggregateError(
        [cause, ...failures],
        "Failed to clean up Work Sandbox creation during shutdown",
      );
      if (this.lifecycle !== "accepting") {
        this.shutdownCleanupFailures.push(cleanupError);
      }
      throw cleanupError;
    }
  }

  private async saveCleanupError(
    record: WorkRecord,
    error: unknown,
  ): Promise<void> {
    const detail = errorMessage(error);
    await this.records.save(
      activity(
        { ...record, status: "error", lastError: detail },
        "error",
        `Cleanup failed: ${detail}`,
      ),
    );
  }

  private async requireOwnedRecord(
    owner: WorkOwner,
    workId: string,
  ): Promise<WorkRecord> {
    const record = await this.records.get(workId);
    if (
      record.repositoryRoot !== owner.canonicalRoot ||
      record.paseoProjectId !== owner.paseoProjectId ||
      record.paseoWorkspaceId !== owner.paseoWorkspaceId
    ) {
      throw new Error("Work Sandbox is not owned by this project capability");
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

  private async closeRemoteConnection(
    workId: string,
    suppressErrors = true,
  ): Promise<void> {
    const connection = this.remoteConnections.get(workId);
    this.remoteConnections.delete(workId);
    if (!connection) return;
    if (suppressErrors) {
      await connection.close().catch(() => undefined);
      return;
    }
    await connection.close();
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
      paseoProjectId: record.paseoProjectId,
      cubeProjectId: record.cubeProjectId ?? record.projectId,
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
      quarantined: isQuarantinedRecord(record) || undefined,
    });
  }
}
