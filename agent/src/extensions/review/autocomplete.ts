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
    return filterAutocompleteItems(
      [...REVIEW_TARGET_AUTOCOMPLETE_ITEMS, ...REVIEW_FLAG_AUTOCOMPLETE_ITEMS],
      trailing.value,
    );
  }

  const branchValueMatch = trimmed.match(/^(?:branch|br)\s+(\S*)$/i);
  if (branchValueMatch) {
    const branches = await getLocalBranches(pi);
    return filterAutocompleteItems(
      branches.map((branch) => ({
        value: `${trimmed.slice(0, trimmed.length - branchValueMatch[1]!.length)}${branch}`,
        label: branch,
      })),
      branchValueMatch[1] ?? "",
    );
  }

  const commitValueMatch = trimmed.match(/^commit\s+(\S*)$/i);
  if (commitValueMatch) {
    const commits = await getRecentCommits(pi);
    return filterAutocompleteItems(
      commits.map((commit) => ({
        value: `${trimmed.slice(0, trimmed.length - commitValueMatch[1]!.length)}${commit.sha}`,
        label: commit.sha.slice(0, 7),
        description: commit.title,
      })),
      commitValueMatch[1] ?? "",
    );
  }

  const folderValueMatch = trimmed.match(/^folder\s+(\S*)$/i);
  if (folderValueMatch) {
    const paths = await getTrackedPaths(pi);
    return filterAutocompleteItems(
      paths.map((candidate) => ({
        value: `${trimmed.slice(0, trimmed.length - folderValueMatch[1]!.length)}${candidate}`,
        label: candidate,
      })),
      folderValueMatch[1] ?? "",
    );
  }

  if (/^(?:uncommitted|u)(?:\s+.*)?$/i.test(trimmed)) {
    if (trailing.hasTrailingSpace) {
      return REVIEW_FLAG_AUTOCOMPLETE_ITEMS.map((item) => ({
        ...item,
        value: `${trimmed} ${item.value}`,
      }));
    }

    const afterTarget = trimmed.replace(/^(?:uncommitted|u)\s+/i, "");
    if (afterTarget.startsWith("--")) {
      return filterAutocompleteItems(
        REVIEW_FLAG_AUTOCOMPLETE_ITEMS.map((item) => ({
          ...item,
          value: `uncommitted ${item.value}`,
        })),
        afterTarget,
      );
    }
  }

  const resolvedTargetMatch = trimmed.match(
    /^(?:branch|br|commit|pr|folder)\s+\S+(?:\s+(--\S*))?$/i,
  );
  if (resolvedTargetMatch) {
    if (trailing.hasTrailingSpace) {
      return REVIEW_FLAG_AUTOCOMPLETE_ITEMS.map((item) => ({
        ...item,
        value: `${trimmed} ${item.value}`,
      }));
    }

    const trailingToken = resolvedTargetMatch[1];
    if (trailingToken?.startsWith("--")) {
      return filterAutocompleteItems(
        REVIEW_FLAG_AUTOCOMPLETE_ITEMS.map((item) => ({
          ...item,
          value: `${trimmed.slice(0, trimmed.length - trailingToken.length)}${item.value}`,
        })),
        trailingToken,
      );
    }
  }

  return null;
}
