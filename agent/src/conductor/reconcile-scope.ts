import { Type, type Static } from "typebox";

import type { ManagedRepositoryConfig } from "./config.js";
import type { GitHubClient, PullRequestSnapshot, PullRequestSummary } from "./github.js";
import { PullRequestFeedbackSchema } from "./github-feedback.js";
import type { RunRecord, WorkItem } from "./store/types.js";

export const ReconcileScopeSchema = Type.Object({
  repositories: Type.Optional(
    Type.Array(Type.Object({ owner: Type.String(), repo: Type.String() })),
  ),
  owner: Type.Optional(Type.String()),
  repo: Type.Optional(Type.String()),
  issueNumber: Type.Optional(Type.Number({ minimum: 1 })),
  prNumber: Type.Optional(Type.Number({ minimum: 1 })),
  branch: Type.Optional(Type.String()),
  baseBranch: Type.Optional(Type.String()),
  projectItemId: Type.Optional(Type.String()),
  projectScan: Type.Optional(Type.Boolean()),
  activeRuns: Type.Optional(Type.Boolean()),
  mergeabilityProbe: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String()),
  feedback: Type.Optional(Type.Array(PullRequestFeedbackSchema)),
  pullRequest: Type.Optional(
    Type.Object({
      number: Type.Number({ minimum: 1 }),
      url: Type.String(),
      headRefName: Type.String(),
      baseRefName: Type.Optional(Type.String()),
      baseRefOid: Type.Optional(Type.String()),
      headRefOid: Type.Optional(Type.String()),
      state: Type.String(),
      isDraft: Type.Boolean(),
      mergedAt: Type.Optional(Type.String()),
      mergeable: Type.Optional(Type.String()),
      mergeStateStatus: Type.Optional(Type.String()),
      linkedIssueNumbers: Type.Optional(Type.Array(Type.Number({ minimum: 1 }))),
    }),
  ),
});

export type ReconcileScope = Static<typeof ReconcileScopeSchema>;
export {
  dispatchProjectScanCandidates,
  groupRepositoriesByProject,
  listProjectScanCandidates,
  reconcileProjectItemScope,
  reconcileProjectScan,
} from "./project-scan.js";

export async function readPullRequestReconcileSnapshot(input: {
  github: GitHubClient;
  run: RunRecord;
  scope: ReconcileScope | undefined;
}): Promise<PullRequestSnapshot> {
  if (input.scope?.mergeabilityProbe === true) {
    const prNumber = input.scope.prNumber ?? input.run.prNumber;
    return {
      pullRequest: await input.github.getPullRequestMergeState({
        owner: input.run.owner,
        repo: input.run.repo,
        ...(prNumber === undefined ? {} : { prNumber }),
        branch: input.run.branch,
      }),
      feedback: input.scope.feedback ?? [],
    };
  }
  const scopedPullRequest = scopePullRequestForRun(input.scope, input.run);
  if (scopedPullRequest !== undefined) {
    return { pullRequest: scopedPullRequest, feedback: input.scope?.feedback ?? [] };
  }
  return input.github.getPullRequestSnapshot({
    owner: input.run.owner,
    repo: input.run.repo,
    issueNumber: input.run.issueNumber,
    ...(input.run.prNumber === undefined ? {} : { prNumber: input.run.prNumber }),
    branch: input.run.branch,
  });
}

export function shouldScanProjectItems(scope: ReconcileScope | undefined): boolean {
  if (scope?.projectScan === false) return false;
  return (
    scope === undefined ||
    scope.issueNumber !== undefined ||
    scope.projectItemId !== undefined ||
    (scope.prNumber === undefined && scope.branch === undefined && scope.pullRequest === undefined)
  );
}

export function scopeMatchesRepo(
  scope: ReconcileScope | undefined,
  repo: Pick<ManagedRepositoryConfig, "owner" | "repo">,
): boolean {
  if (
    scope?.repositories !== undefined &&
    !scope.repositories.some(
      (entry) =>
        entry.owner.toLowerCase() === repo.owner.toLowerCase() &&
        entry.repo.toLowerCase() === repo.repo.toLowerCase(),
    )
  ) {
    return false;
  }
  if (scope?.owner !== undefined && scope.owner.toLowerCase() !== repo.owner.toLowerCase()) {
    return false;
  }
  if (scope?.repo !== undefined && scope.repo.toLowerCase() !== repo.repo.toLowerCase()) {
    return false;
  }
  return true;
}

export function scopeMatchesWorkItem(
  scope: ReconcileScope | undefined,
  workItem: WorkItem,
): boolean {
  if (!scopeMatchesRepo(scope, workItem)) return false;
  if (scope?.issueNumber !== undefined && scope.issueNumber !== workItem.issueNumber) return false;
  if (scope?.projectItemId !== undefined && scope.projectItemId !== workItem.projectItemId) {
    return false;
  }
  return true;
}

export function scopeMatchesRun(scope: ReconcileScope | undefined, run: RunRecord): boolean {
  if (!scopeMatchesRepo(scope, run)) return false;
  if (scope?.issueNumber !== undefined && scope.issueNumber !== run.issueNumber) return false;
  if (scope?.projectItemId !== undefined && scope.projectItemId !== run.projectItemId) return false;
  if (scope?.branch !== undefined && scope.branch !== run.branch) return false;
  if (scope?.baseBranch !== undefined && scope.baseBranch !== run.baseRef) return false;
  if (scope?.prNumber !== undefined) {
    if (run.prNumber !== undefined) return scope.prNumber === run.prNumber;
    if (scope.branch === undefined && scope.pullRequest === undefined) return false;
  }
  return true;
}

export function scopePullRequestForRun(
  scope: ReconcileScope | undefined,
  run: RunRecord,
): PullRequestSummary | undefined {
  const pr = scope?.pullRequest;
  if (pr === undefined) return pullRequestForFeedback(scope, run);
  if (!scopeMatchesRun(scope, run)) return undefined;
  if (pr.headRefName !== run.branch && run.prNumber !== pr.number) return undefined;
  return pr;
}

function pullRequestForFeedback(
  scope: ReconcileScope | undefined,
  run: RunRecord,
): PullRequestSummary | undefined {
  if (scope?.feedback === undefined || scope.feedback.length === 0) return undefined;
  if (!scopeMatchesRun(scope, run)) return undefined;
  const number = scope.prNumber ?? run.prNumber;
  if (number === undefined) return undefined;
  return {
    number,
    url: run.prUrl ?? `https://github.com/${run.owner}/${run.repo}/pull/${number}`,
    headRefName: scope.branch ?? run.branch,
    state: "OPEN",
    isDraft: false,
  };
}
