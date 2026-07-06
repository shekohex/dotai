import type { ResolvedRepositoryConfig } from "./config.js";
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
