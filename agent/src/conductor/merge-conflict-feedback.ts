import type { PullRequestSummary } from "./github.js";
import type { PullRequestFeedback } from "./github-feedback.js";

export function mergeConflictFeedback(pr: PullRequestSummary): PullRequestFeedback[] {
  if (pr.mergedAt !== undefined) return [];
  const mergeable = pr.mergeable?.toUpperCase();
  const mergeStateStatus = pr.mergeStateStatus?.toUpperCase();
  if (mergeable !== "CONFLICTING" && mergeStateStatus !== "DIRTY") return [];
  return [
    {
      key: `merge-conflict:${pr.number}:${mergeable ?? "UNKNOWN"}:${mergeStateStatus ?? "UNKNOWN"}`,
      kind: "merge_conflict",
      body: `Pull request has merge conflicts. Rebase ${pr.headRefName} onto the target branch and resolve conflicts.`,
      url: pr.url,
      merge_conflict: {
        number: pr.number,
        url: pr.url,
        headRefName: pr.headRefName,
        mergeable: pr.mergeable ?? "",
        mergeStateStatus: pr.mergeStateStatus ?? "",
      },
    },
  ];
}
