import { Type, type Static } from "typebox";

import type { ManagedRepositoryConfig } from "./config.js";
import type { PullRequestSummary } from "./github.js";
import type { RunRecord, WorkItem } from "./store/types.js";

export const ReconcileScopeSchema = Type.Object({
  owner: Type.Optional(Type.String()),
  repo: Type.Optional(Type.String()),
  issueNumber: Type.Optional(Type.Number({ minimum: 1 })),
  prNumber: Type.Optional(Type.Number({ minimum: 1 })),
  branch: Type.Optional(Type.String()),
  projectItemId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  pullRequest: Type.Optional(
    Type.Object({
      number: Type.Number({ minimum: 1 }),
      url: Type.String(),
      headRefName: Type.String(),
      state: Type.String(),
      isDraft: Type.Boolean(),
      mergedAt: Type.Optional(Type.String()),
      linkedIssueNumbers: Type.Optional(Type.Array(Type.Number({ minimum: 1 }))),
    }),
  ),
});

export type ReconcileScope = Static<typeof ReconcileScopeSchema>;

export function shouldScanProjectItems(scope: ReconcileScope | undefined): boolean {
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
  if (pr === undefined) return undefined;
  if (!scopeMatchesRun(scope, run)) return undefined;
  if (pr.headRefName !== run.branch && run.prNumber !== pr.number) return undefined;
  return pr;
}
