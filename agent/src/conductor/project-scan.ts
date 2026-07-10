import type { ManagedRepositoryConfig, ResolvedRepositoryConfig } from "./config.js";
import type { GitHubClient } from "./github-types.js";
import { projectConfigKey } from "./project-key.js";
import { sameRepository } from "./run-record.js";
import {
  dispatchAutomatedWorkItem,
  handleClosedWorkItem,
  hasMergedPullRequestForRun,
  hasRunStatusForWorkItem,
  isEligibleForAutomatedDispatch,
} from "./run-status.js";
import type { ConductorStore, RunRecord, WorkItem } from "./store/types.js";
import type { WorktreeManager } from "./worktree.js";
import { isRateLimitError } from "./rate-limit.js";

export type ProjectScanRuntime = {
  repo: ManagedRepositoryConfig;
  config: ResolvedRepositoryConfig;
};
export type ProjectScanCandidate = ProjectScanRuntime & { workItem: WorkItem };
type ProjectScanDispatchInput = {
  authenticatedLogin: string;
  blockRun(config: ResolvedRepositoryConfig, run: RunRecord): Promise<void>;
  candidates: ProjectScanCandidate[];
  dispatch(repo: ManagedRepositoryConfig, workItem: WorkItem): Promise<RunRecord>;
  github: GitHubClient;
  matchesWorkItem(workItem: WorkItem): boolean;
  store: ConductorStore;
  worktrees: WorktreeManager;
};

export async function reconcileProjectScan(
  input: Omit<ProjectScanDispatchInput, "candidates"> & {
    repositories: ManagedRepositoryConfig[];
    matchesRepository(repo: ManagedRepositoryConfig): boolean;
    loadRuntime(repo: ManagedRepositoryConfig): Promise<ProjectScanRuntime>;
    listProjectItems(config: ResolvedRepositoryConfig): Promise<WorkItem[]>;
  },
): Promise<RunRecord[]> {
  const groups = await groupRepositoriesByProject({
    repositories: input.repositories,
    matchesRepository: (repo) => input.matchesRepository(repo),
    loadRuntime: (repo) => input.loadRuntime(repo),
  });
  const candidates = await listProjectScanCandidates({
    groups,
    listProjectItems: (config) => input.listProjectItems(config),
  });
  return dispatchProjectScanCandidates({
    authenticatedLogin: input.authenticatedLogin,
    blockRun: (config, run) => input.blockRun(config, run),
    candidates,
    dispatch: (repo, workItem) => input.dispatch(repo, workItem),
    github: input.github,
    matchesWorkItem: (workItem) => input.matchesWorkItem(workItem),
    store: input.store,
    worktrees: input.worktrees,
  });
}

export async function groupRepositoriesByProject(input: {
  repositories: ManagedRepositoryConfig[];
  matchesRepository(repo: ManagedRepositoryConfig): boolean;
  loadRuntime(repo: ManagedRepositoryConfig): Promise<ProjectScanRuntime>;
}): Promise<ProjectScanRuntime[][]> {
  const groupedRuntimes = new Map<string, ProjectScanRuntime[]>();
  for (const repo of input.repositories) {
    if (!input.matchesRepository(repo)) continue;
    const runtime = await input.loadRuntime(repo);
    const key = projectConfigKey(runtime.config.project);
    const group = groupedRuntimes.get(key) ?? [];
    group.push(runtime);
    groupedRuntimes.set(key, group);
  }
  return [...groupedRuntimes.values()];
}

export async function listProjectScanCandidates(input: {
  groups: ProjectScanRuntime[][];
  listProjectItems(config: ResolvedRepositoryConfig): Promise<WorkItem[]>;
}): Promise<ProjectScanCandidate[]> {
  const candidates: ProjectScanCandidate[] = [];
  for (const group of input.groups) {
    const first = group[0];
    if (first === undefined) continue;
    const workItems = await input.listProjectItems(first.config);
    candidates.push(
      ...group.flatMap((entry) => workItems.map((workItem) => ({ ...entry, workItem }))),
    );
  }
  return candidates;
}

export async function reconcileProjectItemScope(input: {
  authenticatedLogin: string;
  blockRun(config: ResolvedRepositoryConfig, run: RunRecord): Promise<void>;
  dispatch(repo: ManagedRepositoryConfig, workItem: WorkItem): Promise<RunRecord>;
  github: GitHubClient;
  loadRuntime(repo: ManagedRepositoryConfig): Promise<ProjectScanRuntime>;
  projectItemId: string;
  repositories: ManagedRepositoryConfig[];
  store: ConductorStore;
  worktrees: WorktreeManager;
}): Promise<RunRecord[]> {
  const snapshot = await input.github.getProjectItem(input.projectItemId);
  if (snapshot === undefined) return [];
  const repo = input.repositories.find(
    (entry) =>
      sameRepository(snapshot.workItem, entry) &&
      entry.project.owner.toLowerCase() === snapshot.project.owner.toLowerCase() &&
      entry.project.number === snapshot.project.number,
  );
  if (repo === undefined) return [];
  const runtime = await input.loadRuntime(repo);
  const projectStatus = snapshot.workItem.projectFields[runtime.config.statusField];
  const workItem = {
    ...snapshot.workItem,
    ...(typeof projectStatus === "string" ? { projectStatus } : {}),
  };
  return dispatchProjectScanCandidates({
    authenticatedLogin: input.authenticatedLogin,
    blockRun: (config, run) => input.blockRun(config, run),
    candidates: [{ repo, config: runtime.config, workItem }],
    dispatch: (managedRepo, candidate) => input.dispatch(managedRepo, candidate),
    github: input.github,
    matchesWorkItem: () => true,
    store: input.store,
    worktrees: input.worktrees,
  });
}

export async function dispatchProjectScanCandidates(
  input: ProjectScanDispatchInput,
): Promise<RunRecord[]> {
  const dispatched: RunRecord[] = [];
  for (const { repo, config, workItem } of input.candidates) {
    if (!sameRepository(workItem, config)) continue;
    if (!input.matchesWorkItem(workItem)) continue;
    if (await isClosedWorkItemHandled(input, config, workItem)) continue;
    if (!isEligibleForAutomatedDispatch(workItem, config.dispatchLabel, input.authenticatedLogin)) {
      continue;
    }
    if (await shouldSkipDispatchedWorkItem(input.store, workItem)) continue;
    try {
      dispatched.push(
        ...(await dispatchAutomatedWorkItem({
          config,
          dispatch: () => input.dispatch(repo, workItem),
          github: input.github,
          workItem,
          worktrees: input.worktrees,
        })),
      );
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      continue;
    }
  }
  return dispatched;
}

function isClosedWorkItemHandled(
  input: Pick<ProjectScanDispatchInput, "blockRun" | "github" | "store">,
  config: ResolvedRepositoryConfig,
  workItem: WorkItem,
): Promise<boolean> {
  return handleClosedWorkItem({
    blockRun: (run) => input.blockRun(config, run),
    isRunCompleted: (run) => hasMergedPullRequestForRun({ github: input.github, run }),
    store: input.store,
    workItem,
  });
}

async function shouldSkipDispatchedWorkItem(
  store: ConductorStore,
  workItem: WorkItem,
): Promise<boolean> {
  const active = await store.getActiveRun(workItem.owner, workItem.repo, workItem.issueNumber);
  return (
    active !== undefined ||
    (await hasRunStatusForWorkItem(store, workItem, "blocked")) ||
    (await hasRunStatusForWorkItem(store, workItem, "done"))
  );
}
