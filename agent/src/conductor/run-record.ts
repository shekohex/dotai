import type { ManagedRepositoryConfig, ResolvedRepositoryConfig } from "./config.js";
import type { GitHubClient } from "./github.js";
import { slugify } from "./run-id.js";
import type { RunRecord, WorkItem } from "./store/types.js";
import type { WorktreePlan } from "./worktree.js";

export function runToPlan(run: RunRecord): WorktreePlan {
  return {
    owner: run.owner,
    repo: run.repo,
    issueNumber: run.issueNumber,
    slug: slugify(run.issueTitle),
    branch: run.branch,
    baseRef: run.baseRef,
    worktreePath: run.worktreePath,
  };
}

export function runToWorkItem(run: RunRecord): WorkItem {
  return {
    projectItemId: run.projectItemId,
    ...(run.projectId === undefined ? {} : { projectId: run.projectId }),
    owner: run.owner,
    repo: run.repo,
    issueNumber: run.issueNumber,
    issueState: "OPEN",
    issueUrl: run.issueUrl,
    title: run.issueTitle,
    body: "",
    labels: [],
    assignees: [],
    projectFields: {},
  };
}

export function sameRepository(
  workItem: Pick<WorkItem, "owner" | "repo">,
  config: Pick<ResolvedRepositoryConfig, "owner" | "repo">,
): boolean {
  return (
    workItem.owner.toLowerCase() === config.owner.toLowerCase() &&
    workItem.repo.toLowerCase() === config.repo.toLowerCase()
  );
}

export async function commentWorkItemBestEffort(
  github: GitHubClient,
  workItem: WorkItem,
  body: string | undefined,
): Promise<void> {
  if (body === undefined || body.length === 0) return;
  try {
    await github.commentIssue(workItem, body);
  } catch {}
}

export async function commentRunBestEffort(
  github: GitHubClient,
  run: RunRecord,
  body: string | undefined,
): Promise<void> {
  if (run.prNumber === undefined) {
    await commentWorkItemBestEffort(github, runToWorkItem(run), body);
    return;
  }
  await commentWorkItemBestEffort(
    github,
    { ...runToWorkItem(run), issueNumber: run.prNumber, issueUrl: run.prUrl ?? run.issueUrl },
    body,
  );
}

export async function updateProjectStatusBestEffort(
  github: GitHubClient,
  repo: ManagedRepositoryConfig,
  workItem: WorkItem,
  statusName: string,
): Promise<void> {
  try {
    await github.updateProjectStatus(repo, workItem, statusName);
  } catch {}
}
