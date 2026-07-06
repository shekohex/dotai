import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "../utils/error-message.js";
import { asRecord, readNumber, readString } from "../utils/unknown-data.js";
import { parseJsonValue } from "./json.js";
import { renderBranchTemplate } from "./run-id.js";
import { DEFAULT_WORKFLOW_MARKDOWN } from "./workflow.js";

const execFileAsync = promisify(execFile);

export const LifecycleStatusMappingSchema = Type.Object({
  draft: Type.Optional(Type.String()),
  ready: Type.Optional(Type.String()),
  in_progress: Type.Optional(Type.String()),
  in_review: Type.Optional(Type.String()),
  done: Type.Optional(Type.String()),
  blocked: Type.Optional(Type.String()),
});

export const SecretRefSchema = Type.Union([
  Type.Object({ env: Type.String() }),
  Type.Object({ file: Type.String() }),
]);

export const WebhookConfigSchema = Type.Object({
  host: Type.String(),
  port: Type.Number({ minimum: 1, maximum: 65535 }),
  path: Type.String(),
  secret: SecretRefSchema,
});

export const ProjectConfigSchema = Type.Object({
  owner: Type.String(),
  number: Type.Number({ minimum: 0 }),
});

export const WorktreeHooksSchema = Type.Object({
  postCreate: Type.Optional(Type.Array(Type.String())),
  preRemove: Type.Optional(Type.Array(Type.String())),
  postRemove: Type.Optional(Type.Array(Type.String())),
});

export const ManagedRepositoryConfigSchema = Type.Object({
  owner: Type.String(),
  repo: Type.String(),
  repoPath: Type.String(),
  project: ProjectConfigSchema,
  dispatchLabel: Type.Optional(Type.String()),
  branchTemplate: Type.Optional(Type.String()),
  branchPrefix: Type.Optional(Type.String()),
  branchKind: Type.Optional(Type.String()),
  baseRef: Type.Optional(Type.String()),
  worktreeRoot: Type.Optional(Type.String()),
  statusField: Type.Optional(Type.String()),
  effortField: Type.Optional(Type.String()),
  priorityField: Type.Optional(Type.String()),
  statusOptions: Type.Optional(LifecycleStatusMappingSchema),
  worktreeHooks: Type.Optional(WorktreeHooksSchema),
});

export const GlobalConductorConfigSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  version: Type.Literal(1),
  stateRoot: Type.Optional(Type.String()),
  pollingIntervalSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  webhook: Type.Optional(WebhookConfigSchema),
  repositories: Type.Array(ManagedRepositoryConfigSchema),
});

export const ResolvedRepositoryConfigSchema = Type.Object({
  owner: Type.String(),
  repo: Type.String(),
  repoPath: Type.String(),
  project: ProjectConfigSchema,
  dispatchLabel: Type.String(),
  branchTemplate: Type.String(),
  branchPrefix: Type.String(),
  branchKind: Type.String(),
  baseRef: Type.Optional(Type.String()),
  worktreeRoot: Type.String(),
  statusField: Type.String(),
  effortField: Type.String(),
  priorityField: Type.String(),
  statusOptions: Type.Object({
    draft: Type.String(),
    ready: Type.String(),
    in_progress: Type.String(),
    in_review: Type.String(),
    done: Type.String(),
    blocked: Type.String(),
  }),
  worktreeHooks: WorktreeHooksSchema,
});

export type LifecycleStatusMapping = Static<typeof LifecycleStatusMappingSchema>;
export type WorktreeHooks = Static<typeof WorktreeHooksSchema>;
export type WebhookConfig = Static<typeof WebhookConfigSchema>;
export type ManagedRepositoryConfig = Static<typeof ManagedRepositoryConfigSchema>;
export type GlobalConductorConfig = Static<typeof GlobalConductorConfigSchema>;
export type ResolvedRepositoryConfig = Static<typeof ResolvedRepositoryConfigSchema>;

export class MissingConductorConfigError extends Error {
  constructor(readonly configPath: string) {
    super(
      [
        `Conductor config not found: ${configPath}`,
        "Run `pi conductor config init` first.",
        "Then edit project owner/number if needed and run `pi conductor config validate`.",
      ].join("\n"),
    );
  }
}

export const DEFAULT_STATUS_OPTIONS = {
  draft: "Draft",
  ready: "Todo",
  in_progress: "In Progress",
  in_review: "Review",
  done: "Done",
  blocked: "Blocked",
} as const;

export type ConfigInitResult = {
  configPath: string;
  schemaPath: string;
  workflowPath: string;
  createdWorkflow: boolean;
  repository: string;
  repositoryAdded: boolean;
  repositoryCount: number;
  projectOwnerHint: string;
  projectInferred: boolean;
  configMigrated: boolean;
};

export type ConfigMigrationResult = {
  config: GlobalConductorConfig;
  changed: boolean;
};

export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured === undefined || configured.length === 0
    ? join(homedir(), ".pi", "agent")
    : configured;
}

export function getDefaultConductorRoot(): string {
  return join(getAgentDir(), "conductor");
}

export function getDefaultConfigPath(): string {
  return join(getDefaultConductorRoot(), "config.json");
}

export function getConfigSchemaPath(configPath = getDefaultConfigPath()): string {
  return join(dirname(configPath), "config.schema.json");
}

export function getStateRoot(config?: GlobalConductorConfig): string {
  return config?.stateRoot ?? getDefaultConductorRoot();
}

export async function readGlobalConfig(
  configPath = getDefaultConfigPath(),
): Promise<GlobalConductorConfig> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) throw new MissingConductorConfigError(configPath);
    throw error;
  }
  return migrateGlobalConductorConfig(parseJsonValue(text, configPath)).config;
}

export async function readOptionalGlobalConfig(
  configPath = getDefaultConfigPath(),
): Promise<GlobalConductorConfig | undefined> {
  try {
    return await readGlobalConfig(configPath);
  } catch (error) {
    if (error instanceof MissingConductorConfigError) return undefined;
    throw error;
  }
}

export async function writeGlobalConfig(
  config: GlobalConductorConfig,
  configPath = getDefaultConfigPath(),
): Promise<void> {
  const validated = Value.Parse(GlobalConductorConfigSchema, config);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(`${configPath}.tmp`, `${JSON.stringify(validated, null, 2)}\n`);
  await rename(`${configPath}.tmp`, configPath);
}

export function migrateGlobalConductorConfig(input: unknown): ConfigMigrationResult {
  const record = asRecord(input);
  if (record === undefined) {
    return { config: Value.Parse(GlobalConductorConfigSchema, input), changed: false };
  }
  let changed = false;
  const migrated: Record<string, unknown> = { ...record };
  if (migrated.$schema === undefined) {
    migrated.$schema = "./config.schema.json";
    changed = true;
  }
  if (migrated.version === undefined) {
    migrated.version = 1;
    changed = true;
  }
  return { config: Value.Parse(GlobalConductorConfigSchema, migrated), changed };
}

export async function writeConductorConfigSchema(
  configPath = getDefaultConfigPath(),
): Promise<string> {
  const schemaPath = getConfigSchemaPath(configPath);
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(`${schemaPath}.tmp`, `${JSON.stringify(conductorConfigJsonSchema(), null, 2)}\n`);
  await rename(`${schemaPath}.tmp`, schemaPath);
  return schemaPath;
}

export function conductorConfigJsonSchema(): unknown {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/shekohex/dotai/schemas/pi-conductor-config.schema.json",
    title: "Pi Conductor Config",
    description: "Global Pi Conductor configuration file.",
    ...GlobalConductorConfigSchema,
  };
}

export function resolveRepositoryConfig(
  repo: ManagedRepositoryConfig,
  workflow: Partial<ManagedRepositoryConfig>,
  cli: Partial<ManagedRepositoryConfig> = {},
  stateRoot = getDefaultConductorRoot(),
): ResolvedRepositoryConfig {
  const merged = mergeRepositoryConfig(repo, workflow, cli);

  return Value.Parse(ResolvedRepositoryConfigSchema, {
    owner: merged.owner,
    repo: merged.repo,
    repoPath: merged.repoPath,
    project: merged.project,
    dispatchLabel: merged.dispatchLabel ?? "ready-for-agent",
    branchTemplate:
      merged.branchTemplate ?? "pi/${{ github.issue.number }}-${{ github.issue.slug }}",
    branchPrefix: merged.branchPrefix ?? "pi",
    branchKind: merged.branchKind ?? "issue",
    baseRef: merged.baseRef,
    worktreeRoot: merged.worktreeRoot ?? join(stateRoot, "worktrees", merged.owner, merged.repo),
    statusField: merged.statusField ?? "Status",
    effortField: merged.effortField ?? "Effort",
    priorityField: merged.priorityField ?? "Priority",
    statusOptions: merged.statusOptions,
    worktreeHooks: merged.worktreeHooks,
  });
}

export function validateGlobalConfig(config: GlobalConductorConfig): string[] {
  const errors: string[] = [];
  const seenRepos = new Set<string>();

  for (const repo of config.repositories) {
    const key = `${repo.owner}/${repo.repo}`;
    if (seenRepos.has(key)) errors.push(`${key}: duplicate managed repository`);
    seenRepos.add(key);
    if (repo.project.owner.startsWith("TODO")) errors.push(`${key}: project.owner is TODO`);
    if (repo.project.number < 1) errors.push(`${key}: project.number must be set`);
    if (repo.repoPath.trim().length === 0) errors.push(`${key}: repoPath is empty`);
    if (repo.branchTemplate !== undefined) {
      try {
        validateBranchTemplate(repo.branchTemplate);
      } catch (error) {
        errors.push(`${key}: ${formatConfigError(error)}`);
      }
    }
  }

  if (config.webhook !== undefined && !config.webhook.path.startsWith("/")) {
    errors.push("webhook.path must start with /");
  }

  return errors;
}

export function findManagedRepository(
  config: GlobalConductorConfig,
  owner: string,
  repo: string,
): ManagedRepositoryConfig | undefined {
  return config.repositories.find(
    (entry) =>
      entry.owner.toLowerCase() === owner.toLowerCase() &&
      entry.repo.toLowerCase() === repo.toLowerCase(),
  );
}

export function findManagedRepositoryByPath(
  config: GlobalConductorConfig,
  cwd: string,
): ManagedRepositoryConfig | undefined {
  const normalizedCwd = cwd.replaceAll(/\/+$/g, "");
  return config.repositories.find((entry) => {
    const normalizedRepoPath = entry.repoPath.replaceAll(/\/+$/g, "");
    return (
      normalizedCwd === normalizedRepoPath || normalizedCwd.startsWith(`${normalizedRepoPath}/`)
    );
  });
}

export async function initConfig(
  cwd: string,
  configPath = getDefaultConfigPath(),
): Promise<ConfigInitResult> {
  const repoPath = await detectGitRoot(cwd);
  const repoView = await detectGitHubRepository(repoPath);
  const existingResult = await readOptionalGlobalConfigForInit(configPath);
  const existing = existingResult?.config;
  const repositories = existing?.repositories ?? [];
  const existingRepository = repositories.find((repo) => sameRepository(repo, repoView));
  const detectedRepo: ManagedRepositoryConfig = {
    owner: repoView.owner,
    repo: repoView.repo,
    repoPath,
    project: repoView.project ?? { owner: "TODO_PROJECT_OWNER", number: 0 },
  };
  const nextRepo = mergeInitRepository(existingRepository, detectedRepo);
  const nextRepositories = upsertRepository(repositories, nextRepo);
  await writeGlobalConfig(
    {
      $schema: existing?.$schema ?? "./config.schema.json",
      version: 1,
      pollingIntervalSeconds: existing?.pollingIntervalSeconds ?? 60,
      ...(existing?.stateRoot === undefined ? {} : { stateRoot: existing.stateRoot }),
      ...(existing?.webhook === undefined ? {} : { webhook: existing.webhook }),
      repositories: nextRepositories,
    },
    configPath,
  );
  const schemaPath = await writeConductorConfigSchema(configPath);

  const workflowPath = join(repoPath, ".pi", "WORKFLOW.md");
  const createdWorkflow = await ensureWorkflowTemplate(workflowPath);
  return {
    configPath,
    schemaPath,
    workflowPath,
    createdWorkflow,
    repository: `${repoView.owner}/${repoView.repo}`,
    repositoryAdded: existingRepository === undefined,
    repositoryCount: nextRepositories.length,
    projectOwnerHint: repoView.owner,
    projectInferred: repoView.project !== undefined,
    configMigrated: existingResult?.changed ?? false,
  };
}

async function readOptionalGlobalConfigForInit(
  configPath: string,
): Promise<ConfigMigrationResult | undefined> {
  try {
    return migrateGlobalConductorConfig(
      parseJsonValue(await readFile(configPath, "utf8"), configPath),
    );
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function mergeInitRepository(
  existing: ManagedRepositoryConfig | undefined,
  detected: ManagedRepositoryConfig,
): ManagedRepositoryConfig {
  if (existing === undefined) return detected;
  return {
    ...existing,
    owner: detected.owner,
    repo: detected.repo,
    repoPath: detected.repoPath,
    project: shouldUseDetectedProject(existing.project, detected.project)
      ? detected.project
      : existing.project,
  };
}

function shouldUseDetectedProject(
  existing: ManagedRepositoryConfig["project"],
  detected: ManagedRepositoryConfig["project"],
): boolean {
  return (existing.owner.startsWith("TODO") || existing.number < 1) && detected.number > 0;
}

async function detectGitRoot(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function detectGitHubRepository(
  repoPath: string,
): Promise<{ owner: string; repo: string; project?: { owner: string; number: number } }> {
  const { stdout } = await execFileAsync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,projectsV2"],
    {
      cwd: repoPath,
      encoding: "utf8",
    },
  );
  const parsed = Value.Parse(
    Type.Object({ nameWithOwner: Type.String(), projectsV2: Type.Optional(Type.Unknown()) }),
    parseJsonValue(stdout, "gh repo view"),
  );
  const [owner, repo] = parsed.nameWithOwner.split("/");
  if (owner === undefined || repo === undefined) {
    throw new Error(`gh repo view returned invalid nameWithOwner: ${parsed.nameWithOwner}`);
  }
  return { owner, repo, project: inferSingleProject(parsed.projectsV2) };
}

function inferSingleProject(projectsV2: unknown): { owner: string; number: number } | undefined {
  const record = asRecord(projectsV2);
  let nodes: unknown[] = [];
  if (Array.isArray(record?.nodes)) nodes = record.nodes;
  else if (Array.isArray(record?.Nodes)) nodes = record.Nodes;
  const projects = nodes.flatMap((node) => {
    const project = asRecord(node);
    const owner = readString(asRecord(project?.owner)?.login);
    const number = readNumber(project?.number);
    return owner === undefined || number === undefined ? [] : [{ owner, number }];
  });
  return projects.length === 1 ? projects[0] : undefined;
}

async function ensureWorkflowTemplate(workflowPath: string): Promise<boolean> {
  try {
    await access(workflowPath, constants.F_OK);
    return false;
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }

  await mkdir(dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, DEFAULT_WORKFLOW_MARKDOWN);
  return true;
}

function upsertRepository(
  repositories: ManagedRepositoryConfig[],
  nextRepo: ManagedRepositoryConfig,
): ManagedRepositoryConfig[] {
  const next = repositories.filter((repo) => !sameRepository(repo, nextRepo));
  next.push(nextRepo);
  return next;
}

function sameRepository(
  left: Pick<ManagedRepositoryConfig, "owner" | "repo">,
  right: Pick<ManagedRepositoryConfig, "owner" | "repo">,
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function mergeRepositoryConfig(
  repo: ManagedRepositoryConfig,
  workflow: Partial<ManagedRepositoryConfig>,
  cli: Partial<ManagedRepositoryConfig>,
): ManagedRepositoryConfig {
  return {
    owner: cli.owner ?? workflow.owner ?? repo.owner,
    repo: cli.repo ?? workflow.repo ?? repo.repo,
    repoPath: cli.repoPath ?? workflow.repoPath ?? repo.repoPath,
    project: {
      owner: cli.project?.owner ?? workflow.project?.owner ?? repo.project.owner,
      number: cli.project?.number ?? workflow.project?.number ?? repo.project.number,
    },
    dispatchLabel: cli.dispatchLabel ?? workflow.dispatchLabel ?? repo.dispatchLabel,
    branchTemplate: cli.branchTemplate ?? workflow.branchTemplate ?? repo.branchTemplate,
    branchPrefix: cli.branchPrefix ?? workflow.branchPrefix ?? repo.branchPrefix,
    branchKind: cli.branchKind ?? workflow.branchKind ?? repo.branchKind,
    baseRef: cli.baseRef ?? workflow.baseRef ?? repo.baseRef,
    worktreeRoot: cli.worktreeRoot ?? workflow.worktreeRoot ?? repo.worktreeRoot,
    statusField: cli.statusField ?? workflow.statusField ?? repo.statusField,
    effortField: cli.effortField ?? workflow.effortField ?? repo.effortField,
    priorityField: cli.priorityField ?? workflow.priorityField ?? repo.priorityField,
    statusOptions: {
      ...DEFAULT_STATUS_OPTIONS,
      ...repo.statusOptions,
      ...workflow.statusOptions,
      ...cli.statusOptions,
    },
    worktreeHooks: mergeWorktreeHooks(
      repo.worktreeHooks,
      workflow.worktreeHooks,
      cli.worktreeHooks,
    ),
  };
}

function mergeWorktreeHooks(...hooks: Array<WorktreeHooks | undefined>): WorktreeHooks {
  return {
    postCreate: hooks.flatMap((hook) => hook?.postCreate ?? []),
    preRemove: hooks.flatMap((hook) => hook?.preRemove ?? []),
    postRemove: hooks.flatMap((hook) => hook?.postRemove ?? []),
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && String(error.code) === code;
}

export function formatConfigError(error: unknown): string {
  return errorMessage(error);
}

export function validateBranchTemplate(template: string): void {
  renderBranchTemplate(template, {
    prefix: "pi",
    kind: "issue",
    issue: 1,
    slug: "example",
    repo: "repo",
    owner: "owner",
  });
}
