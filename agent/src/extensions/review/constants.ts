import type { AutocompleteItem } from "@mariozechner/pi-tui";

export const REVIEW_STATE_TYPE = "review-session";
export const REVIEW_ANCHOR_TYPE = "review-anchor";
export const REVIEW_SETTINGS_TYPE = "review-settings";
export const REVIEW_WIDGET_KEY = "review";

export const GH_SETUP_INSTRUCTIONS =
  "Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";

export const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
  "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.";

export const REVIEW_HANDOFF_GENERATION_FAILED_MESSAGE =
  "Failed to generate review handoff. Start the review again without `--handoff`, or provide a manual handoff note with `--handoff=...`.";

export const UNCOMMITTED_PROMPT =
  "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

export const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
  "Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

export const BASE_BRANCH_PROMPT_FALLBACK =
  "Review the code changes against the base branch '{branch}'. Start by finding the merge diff between the current branch and {branch}'s upstream, then run `git diff` against that SHA to see what changes would merge into {branch}. Provide prioritized, actionable findings.";

export const COMMIT_PROMPT_WITH_TITLE =
  'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

export const COMMIT_PROMPT =
  "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

export const PULL_REQUEST_PROMPT =
  "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.";

export const PULL_REQUEST_PROMPT_FALLBACK =
  "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. Start by finding the merge base between the current branch and {baseBranch}, then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.";

export const FOLDER_REVIEW_PROMPT =
  "Review the code in the following paths: {paths}. This is a snapshot review, not a diff. Read the files directly in these paths and provide prioritized, actionable findings.";

export const REVIEW_ADDRESS_FINDINGS_PROMPT = `Use the latest completed review summary in this session and address the findings one by one.

Instructions:
1. Treat the findings as a prioritized checklist.
2. Fix in priority order.
3. If a finding is invalid or already fixed, briefly explain why.
4. Run relevant verification for changed code where practical.
5. End with fixed items, skipped items with reasons, and verification results.`;

export const REVIEW_PRESETS = [
  { value: "uncommitted", label: "Review uncommitted changes", description: "" },
  { value: "baseBranch", label: "Review against a base branch", description: "(local)" },
  { value: "commit", label: "Review a commit", description: "" },
  { value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
  { value: "folder", label: "Review a folder (or more)", description: "(snapshot, not diff)" },
] as const;

export const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = "toggleCustomInstructions" as const;

export const REVIEW_TARGET_AUTOCOMPLETE_ITEMS: AutocompleteItem[] = [
  {
    value: "uncommitted ",
    label: "uncommitted",
    description: "Review staged, unstaged, and untracked changes",
  },
  {
    value: "branch ",
    label: "branch",
    description: "Review changes against another branch (alias: br)",
  },
  {
    value: "commit ",
    label: "commit",
    description: "Review a specific commit",
  },
  {
    value: "pr ",
    label: "pr",
    description: "Review a GitHub pull request by number or URL",
  },
  {
    value: "folder ",
    label: "folder",
    description: "Review one or more paths as a snapshot",
  },
];

export const REVIEW_FLAG_AUTOCOMPLETE_ITEMS: AutocompleteItem[] = [
  {
    value: "--extra ",
    label: "--extra",
    description: "Add extra reviewer focus instructions",
  },
  {
    value: "--handoff",
    label: "--handoff",
    description: "Generate reviewer handoff from current session context",
  },
  {
    value: "--handoff ",
    label: "--handoff <text>",
    description: "Add an explicit author handoff note",
  },
];
