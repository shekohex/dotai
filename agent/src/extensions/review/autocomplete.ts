import { fuzzyFilter, type AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { REVIEW_FLAG_AUTOCOMPLETE_ITEMS, REVIEW_TARGET_AUTOCOMPLETE_ITEMS } from "./constants.js";
import { getLocalBranches, getRecentCommits, getTrackedPaths } from "./git.js";

function filterAutocompleteItems(
  items: AutocompleteItem[],
  query: string,
): AutocompleteItem[] | null {
  if (items.length === 0) {
    return null;
  }

  if (!query) {
    return items;
  }

  const filtered = fuzzyFilter(
    items,
    query,
    (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
  );
  return filtered.length > 0 ? filtered : null;
}

function getTrailingToken(prefix: string): { value: string; hasTrailingSpace: boolean } {
  const hasTrailingSpace = /\s$/.test(prefix);
  if (hasTrailingSpace) {
    return { value: "", hasTrailingSpace };
  }

  const trimmed = prefix.trimStart();
  const lastWhitespace = Math.max(trimmed.lastIndexOf(" "), trimmed.lastIndexOf("\n"));
  return {
    value: lastWhitespace >= 0 ? trimmed.slice(lastWhitespace + 1) : trimmed,
    hasTrailingSpace,
  };
}

function getInitialReviewCompletions(query: string): AutocompleteItem[] | null {
  return filterAutocompleteItems(
    [...REVIEW_TARGET_AUTOCOMPLETE_ITEMS, ...REVIEW_FLAG_AUTOCOMPLETE_ITEMS],
    query,
  );
}

async function completeBranchValue(
  pi: ExtensionAPI,
  trimmed: string,
): Promise<AutocompleteItem[] | null> {
  const branchValueMatch = trimmed.match(/^(?:branch|br)\s+(\S*)$/i);
  if (!branchValueMatch) {
    return null;
  }

  const branches = await getLocalBranches(pi);
  const branchQuery = branchValueMatch[1] ?? "";
  return filterAutocompleteItems(
    branches.map((branch) => ({
      value: `${trimmed.slice(0, trimmed.length - branchQuery.length)}${branch}`,
      label: branch,
    })),
    branchQuery,
  );
}

async function completeCommitValue(
  pi: ExtensionAPI,
  trimmed: string,
): Promise<AutocompleteItem[] | null> {
  const commitValueMatch = trimmed.match(/^commit\s+(\S*)$/i);
  if (!commitValueMatch) {
    return null;
  }

  const commits = await getRecentCommits(pi);
  const commitQuery = commitValueMatch[1] ?? "";
  return filterAutocompleteItems(
    commits.map((commit) => ({
      value: `${trimmed.slice(0, trimmed.length - commitQuery.length)}${commit.sha}`,
      label: commit.sha.slice(0, 7),
      description: commit.title,
    })),
    commitQuery,
  );
}

async function completeFolderValue(
  pi: ExtensionAPI,
  trimmed: string,
): Promise<AutocompleteItem[] | null> {
  const folderValueMatch = trimmed.match(/^folder\s+(\S*)$/i);
  if (!folderValueMatch) {
    return null;
  }

  const paths = await getTrackedPaths(pi);
  const folderQuery = folderValueMatch[1] ?? "";
  return filterAutocompleteItems(
    paths.map((candidate) => ({
      value: `${trimmed.slice(0, trimmed.length - folderQuery.length)}${candidate}`,
      label: candidate,
    })),
    folderQuery,
  );
}

function completeFlagItems(valuePrefix: string, query: string): AutocompleteItem[] | null {
  return filterAutocompleteItems(
    REVIEW_FLAG_AUTOCOMPLETE_ITEMS.map((item) => ({
      ...item,
      value: `${valuePrefix}${item.value}`,
    })),
    query,
  );
}

function completeUncommittedFlags(
  trimmed: string,
  trailing: { value: string; hasTrailingSpace: boolean },
): AutocompleteItem[] | null {
  if (!/^(?:uncommitted|u)(?:\s+.*)?$/i.test(trimmed)) {
    return null;
  }

  if (trailing.hasTrailingSpace) {
    return REVIEW_FLAG_AUTOCOMPLETE_ITEMS.map((item) => ({
      ...item,
      value: `${trimmed} ${item.value}`,
    }));
  }

  const afterTarget = trimmed.replace(/^(?:uncommitted|u)\s+/i, "");
  if (!afterTarget.startsWith("--")) {
    return null;
  }

  return completeFlagItems("uncommitted ", afterTarget);
}

function completeResolvedTargetFlags(
  trimmed: string,
  trailing: { value: string; hasTrailingSpace: boolean },
): AutocompleteItem[] | null {
  const resolvedTargetMatch = trimmed.match(
    /^(?:branch|br|commit|pr|folder)\s+\S+(?:\s+(--\S*))?$/i,
  );
  if (!resolvedTargetMatch) {
    return null;
  }

  if (trailing.hasTrailingSpace) {
    return REVIEW_FLAG_AUTOCOMPLETE_ITEMS.map((item) => ({
      ...item,
      value: `${trimmed} ${item.value}`,
    }));
  }

  const trailingToken = resolvedTargetMatch[1];
  if (!(trailingToken?.startsWith("--") ?? false)) {
    return null;
  }

  return completeFlagItems(trimmed.slice(0, trimmed.length - trailingToken.length), trailingToken);
}

export async function getReviewArgumentCompletions(
  pi: ExtensionAPI,
  prefix: string,
): Promise<AutocompleteItem[] | null> {
  const trimmed = prefix.trimStart();
  const trailing = getTrailingToken(prefix);

  if (!trimmed) {
    return [...REVIEW_TARGET_AUTOCOMPLETE_ITEMS, ...REVIEW_FLAG_AUTOCOMPLETE_ITEMS];
  }

  if (!trimmed.includes(" ")) {
    return getInitialReviewCompletions(trailing.value);
  }

  const branchCompletions = await completeBranchValue(pi, trimmed);
  if (branchCompletions !== null) {
    return branchCompletions;
  }

  const commitCompletions = await completeCommitValue(pi, trimmed);
  if (commitCompletions !== null) {
    return commitCompletions;
  }

  const folderCompletions = await completeFolderValue(pi, trimmed);
  if (folderCompletions !== null) {
    return folderCompletions;
  }

  const uncommittedCompletions = completeUncommittedFlags(trimmed, trailing);
  if (uncommittedCompletions !== null) {
    return uncommittedCompletions;
  }

  const resolvedTargetCompletions = completeResolvedTargetFlags(trimmed, trailing);
  if (resolvedTargetCompletions !== null) {
    return resolvedTargetCompletions;
  }

  return null;
}
