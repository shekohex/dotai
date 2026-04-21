import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SelectItem } from "@mariozechner/pi-tui";
import {
  getCurrentBranch,
  getDefaultBranch,
  getLocalBranches,
  getRecentCommits,
  hasPendingChanges,
  parseReviewPaths,
  PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE,
  type ReviewTarget,
} from "./deps.js";
import { showSearchableSelect } from "./selector-search.js";

type PullRequestTargetResolver = (
  ctx: ExtensionContext,
  ref: string,
  options?: { skipInitialPendingChangesCheck?: boolean },
) => Promise<ReviewTarget | null>;

export async function showBranchSelector(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<ReviewTarget | null> {
  const branches = await getLocalBranches(pi);
  const currentBranch = await getCurrentBranch(pi);
  const defaultBranch = await getDefaultBranch(pi);
  const hasCurrentBranch = typeof currentBranch === "string" && currentBranch.length > 0;
  const candidateBranches = hasCurrentBranch
    ? branches.filter((branch) => branch !== currentBranch)
    : branches;
  if (candidateBranches.length === 0) {
    ctx.ui.notify(
      hasCurrentBranch
        ? `No other branches found (current branch: ${currentBranch})`
        : "No branches found",
      "error",
    );
    return null;
  }

  const items: SelectItem[] = candidateBranches
    .slice()
    .toSorted((left, right) => {
      if (left === defaultBranch) return -1;
      if (right === defaultBranch) return 1;
      return left.localeCompare(right);
    })
    .map((branch) => ({
      value: branch,
      label: branch,
      description: branch === defaultBranch ? "(default)" : "",
    }));
  const result = await showSearchableSelect(ctx, {
    title: "Select base branch",
    emptyMessage: "  No matching branches",
    items,
  });

  return result !== null && result.length > 0 ? { type: "baseBranch", branch: result } : null;
}

export async function showCommitSelector(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<ReviewTarget | null> {
  const commits = await getRecentCommits(pi);
  if (commits.length === 0) {
    ctx.ui.notify("No commits found", "error");
    return null;
  }

  const items: SelectItem[] = commits.map((commit) => ({
    value: commit.sha,
    label: `${commit.sha.slice(0, 7)} ${commit.title}`,
    description: "",
  }));
  const selectedSha = await showSearchableSelect(ctx, {
    title: "Select commit to review",
    emptyMessage: "  No matching commits",
    items,
  });

  const result =
    selectedSha === null
      ? null
      : (commits.find((candidate) => candidate.sha === selectedSha) ?? null);

  if (result === null) {
    return null;
  }

  return { type: "commit", sha: result.sha, title: result.title };
}

export async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
  const result = await ctx.ui.editor(
    "Enter folders or files to review (space-separated or one per line):",
    ".",
  );
  if (typeof result !== "string" || result.trim().length === 0) {
    return null;
  }

  const paths = parseReviewPaths(result);
  return paths.length > 0 ? { type: "folder", paths } : null;
}

export async function showPrInput(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  resolvePullRequestTarget: PullRequestTargetResolver,
): Promise<ReviewTarget | null> {
  if (await hasPendingChanges(pi)) {
    ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
    return null;
  }

  const prRef = await ctx.ui.editor(
    "Enter PR number or URL (for example 123 or https://github.com/owner/repo/pull/123):",
    "",
  );
  if (typeof prRef !== "string" || prRef.trim().length === 0) {
    return null;
  }

  return resolvePullRequestTarget(ctx, prRef, { skipInitialPendingChangesCheck: true });
}
