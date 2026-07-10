import type { PullRequestSummary } from "./github.js";
import type { PullRequestFeedback } from "./github-feedback.js";
import type { MergeConflictEpisode } from "./store/types.js";

export function createMergeConflictEpisode(
  pr: PullRequestSummary,
  detectedAt: string,
): MergeConflictEpisode | undefined {
  if (!hasMergeConflict(pr)) return undefined;
  const baseRefOid = pr.baseRefOid ?? pr.baseRefName ?? "unknown-base";
  const headRefOid = pr.headRefOid ?? pr.headRefName;
  return {
    fingerprint: mergeConflictFingerprint(pr, baseRefOid, headRefOid),
    baseRefName: pr.baseRefName ?? "target branch",
    baseRefOid,
    headRefOid,
    detectedAt,
  };
}

export function hasMergeConflict(pr: PullRequestSummary): boolean {
  if (pr.mergedAt !== undefined || pr.state.toUpperCase() !== "OPEN") return false;
  const mergeable = pr.mergeable?.toUpperCase();
  const mergeStateStatus = pr.mergeStateStatus?.toUpperCase();
  return mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY";
}

export function isMergeConflictStateKnown(pr: PullRequestSummary): boolean {
  const mergeable = pr.mergeable?.toUpperCase();
  const mergeStateStatus = pr.mergeStateStatus?.toUpperCase();
  return !(
    (mergeable === undefined || mergeable === "UNKNOWN") &&
    (mergeStateStatus === undefined || mergeStateStatus === "UNKNOWN")
  );
}

export function mergeConflictFeedback(
  pr: PullRequestSummary,
  episode?: MergeConflictEpisode,
): PullRequestFeedback[] {
  const resolvedEpisode = episode ?? createMergeConflictEpisode(pr, new Date().toISOString());
  if (resolvedEpisode === undefined) return [];
  return [
    {
      key: `merge-conflict:${resolvedEpisode.fingerprint}`,
      kind: "merge_conflict",
      body: `Pull request has merge conflicts. Fetch ${resolvedEpisode.baseRefName}, rebase ${pr.headRefName} onto it, resolve conflicts, and push the updated branch.`,
      url: pr.url,
      merge_conflict: {
        number: pr.number,
        url: pr.url,
        headRefName: pr.headRefName,
        headRefOid: resolvedEpisode.headRefOid,
        baseRefName: resolvedEpisode.baseRefName,
        baseRefOid: resolvedEpisode.baseRefOid,
        fingerprint: resolvedEpisode.fingerprint,
        mergeable: pr.mergeable ?? "",
        mergeStateStatus: pr.mergeStateStatus ?? "",
      },
    },
  ];
}

function mergeConflictFingerprint(
  pr: PullRequestSummary,
  baseRefOid: string,
  headRefOid: string,
): string {
  if (pr.baseRefOid !== undefined || pr.headRefOid !== undefined) {
    return `${pr.number}:${baseRefOid}:${headRefOid}`;
  }
  return `${pr.number}:${pr.mergeable?.toUpperCase() ?? "UNKNOWN"}:${pr.mergeStateStatus?.toUpperCase() ?? "UNKNOWN"}`;
}
