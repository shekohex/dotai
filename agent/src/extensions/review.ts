import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  type AutocompleteItem,
  Container,
  fuzzyFilter,
  Input,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import { promises as fs } from "node:fs";
import path from "node:path";

import { installChildBootstrap, isChildSession } from "../subagent-sdk/bootstrap.js";
import { buildLaunchCommand, readChildState } from "../subagent-sdk/launch.js";
import type { MuxAdapter } from "../subagent-sdk/mux.js";
import { createDefaultSubagentRuntimeHooks } from "../subagent-sdk/runtime-hooks.js";
import { createSubagentSDK } from "../subagent-sdk/sdk.js";
import { TmuxAdapter } from "../subagent-sdk/tmux.js";
import { SUBAGENT_STATUS_MESSAGE } from "../subagent-sdk/types.js";
import { copyTextToClipboard } from "../utils/clipboard.js";
import {
  generateContextTransferSummary,
  generateContextTransferSummaryWithLoader,
  getConversationMessages,
  type SummaryGenerationResult,
} from "./session-launch-utils.js";

type CreateReviewExtensionOptions = {
  adapterFactory?: (pi: ExtensionAPI) => MuxAdapter;
  enabled?: boolean;
  handoffGenerator?: (input: {
    ctx: ExtensionCommandContext;
    goal: string;
    messages: ReturnType<typeof getConversationMessages>;
  }) => Promise<SummaryGenerationResult>;
  completionActionPicker?: (input: {
    ctx: ExtensionContext;
    summary: string;
  }) => Promise<"address" | "copy" | "fork" | undefined>;
  clipboardWriter?: (text: string) => Promise<void>;
};

type ReviewSessionState = {
  active: boolean;
  subagentSessionId?: string;
  targetLabel?: string;
  branchAnchorId?: string;
  checkoutToRestore?: ReviewCheckoutTarget;
};

type ReviewSettingsState = {
  customInstructions?: string;
};

type ReviewCheckoutTarget = { type: "branch"; name: string } | { type: "detached"; commit: string };

type ReviewTarget =
  | { type: "uncommitted" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | {
      type: "pullRequest";
      prNumber: number;
      baseBranch: string;
      title: string;
      checkoutToRestore?: ReviewCheckoutTarget;
    }
  | { type: "folder"; paths: string[] };

type ParsedPrReference = {
  prNumber: number;
  repo?: string;
};

type ParsedReviewArgs = {
  target: ReviewTarget | { type: "pr"; ref: string } | null;
  requestedTargetType?: "uncommitted" | "branch" | "commit" | "pr" | "folder";
  extraInstruction?: string;
  handoffRequested?: boolean;
  handoffInstruction?: string;
  error?: string;
};

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_ANCHOR_TYPE = "review-anchor";
const REVIEW_SETTINGS_TYPE = "review-settings";
const REVIEW_WIDGET_KEY = "review";
const GH_SETUP_INSTRUCTIONS =
  "Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
  "Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.";
const REVIEW_HANDOFF_GENERATION_FAILED_MESSAGE =
  "Failed to generate review handoff. Start the review again without `--handoff`, or provide a manual handoff note with `--handoff=...`.";

const UNCOMMITTED_PROMPT =
  "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
  "Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const BASE_BRANCH_PROMPT_FALLBACK =
  "Review the code changes against the base branch '{branch}'. Start by finding the merge diff between the current branch and {branch}'s upstream, then run `git diff` against that SHA to see what changes would merge into {branch}. Provide prioritized, actionable findings.";

const COMMIT_PROMPT_WITH_TITLE =
  'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT =
  "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT =
  "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT_FALLBACK =
  "Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. Start by finding the merge base between the current branch and {baseBranch}, then run `git diff` against that SHA to see the changes that would be merged. Provide prioritized, actionable findings.";

const FOLDER_REVIEW_PROMPT =
  "Review the code in the following paths: {paths}. This is a snapshot review, not a diff. Read the files directly in these paths and provide prioritized, actionable findings.";

const REVIEW_ADDRESS_FINDINGS_PROMPT = `Use the latest completed review summary in this session and address the findings one by one.

Instructions:
1. Treat the findings as a prioritized checklist.
2. Fix in priority order.
3. If a finding is invalid or already fixed, briefly explain why.
4. Run relevant verification for changed code where practical.
5. End with fixed items, skipped items with reasons, and verification results.`;

const REVIEW_PRESETS = [
  { value: "uncommitted", label: "Review uncommitted changes", description: "" },
  { value: "baseBranch", label: "Review against a base branch", description: "(local)" },
  { value: "commit", label: "Review a commit", description: "" },
  { value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
  { value: "folder", label: "Review a folder (or more)", description: "(snapshot, not diff)" },
] as const;

const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = "toggleCustomInstructions" as const;

const REVIEW_TARGET_AUTOCOMPLETE_ITEMS: AutocompleteItem[] = [
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

const REVIEW_FLAG_AUTOCOMPLETE_ITEMS: AutocompleteItem[] = [
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

function stripMarkdownSection(content: string, heading: string): string {
  const pattern = new RegExp(`(?:^|\\n)## ${heading}\\s*[\\s\\S]*?(?=(?:\\n## )|$)`, "i");
  return content.replace(pattern, "").trim();
}

function buildReviewAuthorTask(targetLabel: string, handoffInstruction?: string): string {
  const lines = [`Review ${targetLabel} using the review instructions in this prompt.`];
  if (handoffInstruction?.trim()) {
    lines.push(`Author guidance: ${handoffInstruction.trim()}`);
  }

  return lines.join("\n");
}

export function buildReviewHandoffPrompt(options: {
  summary: string;
  targetLabel: string;
  handoffInstruction?: string;
  parentSessionPath?: string;
}): string {
  const sections = [
    stripMarkdownSection(options.summary, "Task"),
    `## Task\n${buildReviewAuthorTask(options.targetLabel, options.handoffInstruction)}`,
    options.parentSessionPath
      ? `## Parent Session\nParent session: ${options.parentSessionPath}\nIf you need additional detail from the parent session, use \`session_query\` with \`sessionPath\` set to the path above and a focused \`question\`.`
      : undefined,
  ].filter((value): value is string => Boolean(value));

  return sections.join("\n\n");
}

function setReviewWidget(
  ctx: ExtensionContext,
  options:
    | undefined
    | {
        targetLabel?: string;
        statusText?: string;
      },
): void {
  if (!ctx.hasUI) {
    return;
  }

  if (!options) {
    ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    return;
  }

  const message = ["Review session active", options.targetLabel, options.statusText]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  ctx.ui.setWidget(REVIEW_WIDGET_KEY, (_tui, theme) => {
    const text = new Text(theme.fg("warning", message), 0, 0);
    return {
      render(width: number) {
        return text.render(width);
      },
      invalidate() {
        text.invalidate();
      },
    };
  });
}

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
  let state: ReviewSessionState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
      state = entry.data as ReviewSessionState | undefined;
    }
  }

  return state;
}

export function isReviewStateActiveOnBranch(
  state: ReviewSessionState | undefined,
  branchEntries: Array<{ id?: string }>,
): state is ReviewSessionState {
  if (!state?.active) {
    return false;
  }

  if (!state.branchAnchorId) {
    return true;
  }

  return branchEntries.some(
    (entry) => typeof entry.id === "string" && entry.id === state.branchAnchorId,
  );
}

function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
  let state: ReviewSettingsState | undefined;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
      state = entry.data as ReviewSettingsState | undefined;
    }
  }

  return {
    customInstructions: state?.customInstructions?.trim() || undefined,
  };
}

async function findGitRoot(startDir: string): Promise<string | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    const gitPath = path.join(currentDir, ".git");
    const gitStats = await fs.stat(gitPath).catch(() => null);
    if (gitStats?.isDirectory() || gitStats?.isFile()) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
  let currentDir = path.resolve(cwd);
  const gitRoot = await findGitRoot(currentDir);

  while (true) {
    const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");
    const guidelineStats = await fs.stat(guidelinesPath).catch(() => null);
    if (guidelineStats?.isFile()) {
      try {
        const content = await fs.readFile(guidelinesPath, "utf8");
        const trimmed = content.trim();
        return trimmed || null;
      } catch {
        return null;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir || currentDir === gitRoot) {
      return null;
    }
    currentDir = parentDir;
  }
}

async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
  try {
    const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
    if (upstream.code === 0 && upstream.stdout.trim()) {
      const mergeBase = await pi.exec("git", ["merge-base", "HEAD", upstream.stdout.trim()]);
      if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
        return mergeBase.stdout.trim();
      }
    }

    const mergeBase = await pi.exec("git", ["merge-base", "HEAD", branch]);
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
      return mergeBase.stdout.trim();
    }

    return null;
  } catch {
    return null;
  }
}

async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
  const result = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function getRecentCommits(
  pi: ExtensionAPI,
  limit = 20,
): Promise<Array<{ sha: string; title: string }>> {
  const result = await pi.exec("git", ["log", "--oneline", "-n", String(limit)]);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split(" ");
      return { sha, title: rest.join(" ") };
    });
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const result = await pi.exec("git", ["status", "--porcelain"]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
  const result = await pi.exec("git", ["status", "--porcelain"]);
  if (result.code !== 0) {
    return false;
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => !line.startsWith("??"));
}

export function parsePrReference(ref: string): ParsedPrReference | null {
  const trimmed = ref.trim();
  const number = Number.parseInt(trimmed, 10);
  if (Number.isInteger(number) && number > 0) {
    return { prNumber: number };
  }

  const urlMatch = trimmed.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!urlMatch?.[1] || !urlMatch?.[2]) {
    return null;
  }

  const prNumberFromUrl = Number.parseInt(urlMatch[2], 10);
  if (!Number.isInteger(prNumberFromUrl) || prNumberFromUrl <= 0) {
    return null;
  }

  return {
    prNumber: prNumberFromUrl,
    repo: urlMatch[1],
  };
}

async function getPrInfo(
  pi: ExtensionAPI,
  prNumber: number,
  repo?: string,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
  const command = ["pr", "view", String(prNumber), "--json", "baseRefName,title,headRefName"];
  if (repo) {
    command.push("--repo", repo);
  }
  const result = await pi.exec("gh", command);
  if (result.code !== 0) {
    return null;
  }

  try {
    const data = JSON.parse(result.stdout) as {
      baseRefName?: string;
      title?: string;
      headRefName?: string;
    };
    if (!data.baseRefName || !data.title || !data.headRefName) {
      return null;
    }

    return {
      baseBranch: data.baseRefName,
      title: data.title,
      headBranch: data.headRefName,
    };
  } catch {
    return null;
  }
}

async function checkoutPr(
  pi: ExtensionAPI,
  prNumber: number,
  repo?: string,
): Promise<{ success: boolean; error?: string }> {
  const command = ["pr", "checkout", String(prNumber)];
  if (repo) {
    command.push("--repo", repo);
  }
  const result = await pi.exec("gh", command);
  if (result.code !== 0) {
    return { success: false, error: result.stderr || result.stdout || "Failed to checkout PR" };
  }

  return { success: true };
}

async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
  const result = await pi.exec("git", ["branch", "--show-current"]);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

async function getCurrentCheckoutTarget(pi: ExtensionAPI): Promise<ReviewCheckoutTarget | null> {
  const branchResult = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.code === 0 && branchResult.stdout.trim()) {
    return { type: "branch", name: branchResult.stdout.trim() };
  }

  const commitResult = await pi.exec("git", ["rev-parse", "--verify", "HEAD"]);
  if (commitResult.code === 0 && commitResult.stdout.trim()) {
    return { type: "detached", commit: commitResult.stdout.trim() };
  }

  return null;
}

async function restoreCheckoutTarget(
  pi: ExtensionAPI,
  target: ReviewCheckoutTarget | undefined,
): Promise<{ success: boolean; error?: string }> {
  if (!target) {
    return { success: true };
  }

  const args =
    target.type === "branch" ? ["checkout", target.name] : ["checkout", "--detach", target.commit];
  const result = await pi.exec("git", args);
  if (result.code !== 0) {
    return {
      success: false,
      error: result.stderr || result.stdout || "Failed to restore original checkout",
    };
  }

  return { success: true };
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
  const remoteHead = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim().replace("origin/", "");
  }

  const branches = await getLocalBranches(pi);
  if (branches.includes("main")) {
    return "main";
  }
  if (branches.includes("master")) {
    return "master";
  }

  return "main";
}

async function buildReviewPrompt(pi: ExtensionAPI, target: ReviewTarget): Promise<string> {
  switch (target.type) {
    case "uncommitted":
      return UNCOMMITTED_PROMPT;
    case "baseBranch": {
      const mergeBase = await getMergeBase(pi, target.branch);
      return mergeBase
        ? BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(
            /{mergeBaseSha}/g,
            mergeBase,
          )
        : BASE_BRANCH_PROMPT_FALLBACK.replace(/{branch}/g, target.branch);
    }
    case "commit":
      return target.title
        ? COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title)
        : COMMIT_PROMPT.replace("{sha}", target.sha);
    case "pullRequest": {
      const mergeBase = await getMergeBase(pi, target.baseBranch);
      return mergeBase
        ? PULL_REQUEST_PROMPT.replace(/{prNumber}/g, String(target.prNumber))
            .replace(/{title}/g, target.title)
            .replace(/{baseBranch}/g, target.baseBranch)
            .replace(/{mergeBaseSha}/g, mergeBase)
        : PULL_REQUEST_PROMPT_FALLBACK.replace(/{prNumber}/g, String(target.prNumber))
            .replace(/{title}/g, target.title)
            .replace(/{baseBranch}/g, target.baseBranch);
    }
    case "folder":
      return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
  }
}

function getUserFacingHint(target: ReviewTarget): string {
  switch (target.type) {
    case "uncommitted":
      return "current changes";
    case "baseBranch":
      return `changes against '${target.branch}'`;
    case "commit":
      return target.title
        ? `commit ${target.sha.slice(0, 7)}: ${target.title}`
        : `commit ${target.sha.slice(0, 7)}`;
    case "pullRequest":
      return `PR #${target.prNumber}: ${target.title.length > 30 ? `${target.title.slice(0, 27)}...` : target.title}`;
    case "folder": {
      const joined = target.paths.join(", ");
      return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`;
    }
  }
}

export function parseReviewPaths(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => item.trim()).filter(Boolean);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.includes("\n")) {
    return trimmed
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return tokenizeArgs(trimmed)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeReviewTargetToken(
  value: string | undefined,
): ParsedReviewArgs["requestedTargetType"] {
  switch (value?.toLowerCase()) {
    case "uncommitted":
    case "u":
      return "uncommitted";
    case "branch":
    case "br":
      return "branch";
    case "commit":
      return "commit";
    case "pr":
      return "pr";
    case "folder":
      return "folder";
    default:
      return undefined;
  }
}

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

async function getTrackedPaths(pi: ExtensionAPI): Promise<string[]> {
  const result = await pi.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
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

async function getReviewArgumentCompletions(
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

function tokenizeArgs(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && index + 1 < value.length) {
        current += value[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function isReviewTargetToken(value: string | undefined): boolean {
  return normalizeReviewTargetToken(value) !== undefined;
}

function consumeFlagValue(
  parts: string[],
  startIndex: number,
  initialValue?: string,
  options: { stopAtTarget?: boolean } = {},
): { value?: string; nextIndex: number } {
  const collected = initialValue ? [initialValue] : [];
  let nextIndex = startIndex;

  while (nextIndex < parts.length) {
    const part = parts[nextIndex];
    if (part.startsWith("--")) {
      break;
    }
    if (options.stopAtTarget && isReviewTargetToken(part)) {
      break;
    }

    collected.push(part);
    nextIndex += 1;
  }

  return {
    value: collected.length > 0 ? collected.join(" ") : undefined,
    nextIndex,
  };
}

function parseArgs(args: string | undefined): ParsedReviewArgs {
  if (!args?.trim()) {
    return { target: null };
  }

  const rawParts = tokenizeArgs(args.trim());
  const parts: string[] = [];
  let extraInstruction: string | undefined;
  let handoffRequested = false;
  let handoffInstruction: string | undefined;

  for (let index = 0; index < rawParts.length; index++) {
    const part = rawParts[index];
    if (part === "--extra") {
      const consumed = consumeFlagValue(rawParts, index + 1, undefined, { stopAtTarget: true });
      if (!consumed.value) {
        return { target: null, error: "Missing value for --extra" };
      }
      extraInstruction = consumed.value;
      index = consumed.nextIndex - 1;
      continue;
    }

    if (part.startsWith("--extra=")) {
      const consumed = consumeFlagValue(rawParts, index + 1, part.slice("--extra=".length), {
        stopAtTarget: true,
      });
      extraInstruction = consumed.value;
      index = consumed.nextIndex - 1;
      continue;
    }

    if (part === "--handoff") {
      handoffRequested = true;
      const consumed = consumeFlagValue(rawParts, index + 1, undefined, { stopAtTarget: true });
      if (consumed.value) {
        handoffInstruction = consumed.value;
        index = consumed.nextIndex - 1;
      }
      continue;
    }

    if (part.startsWith("--handoff=")) {
      handoffRequested = true;
      const consumed = consumeFlagValue(rawParts, index + 1, part.slice("--handoff=".length), {
        stopAtTarget: true,
      });
      handoffInstruction = consumed.value;
      index = consumed.nextIndex - 1;
      continue;
    }

    parts.push(part);
  }

  const requestedTargetType = normalizeReviewTargetToken(parts[0]);

  if (parts.length === 0) {
    return {
      target: null,
      requestedTargetType,
      extraInstruction,
      handoffRequested,
      handoffInstruction,
    };
  }

  switch (requestedTargetType) {
    case "uncommitted":
      return {
        target: { type: "uncommitted" },
        requestedTargetType,
        extraInstruction,
        handoffRequested,
        handoffInstruction,
      };
    case "branch":
      return parts[1]
        ? {
            target: { type: "baseBranch", branch: parts[1] },
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          }
        : {
            target: null,
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          };
    case "commit":
      return parts[1]
        ? {
            target: {
              type: "commit",
              sha: parts[1],
              title: parts.slice(2).join(" ") || undefined,
            },
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          }
        : {
            target: null,
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          };
    case "folder": {
      const paths = parseReviewPaths(parts.slice(1));
      return paths.length > 0
        ? {
            target: { type: "folder", paths },
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          }
        : {
            target: null,
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          };
    }
    case "pr":
      return parts[1]
        ? {
            target: { type: "pr", ref: parts[1] },
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          }
        : {
            target: null,
            requestedTargetType,
            extraInstruction,
            handoffRequested,
            handoffInstruction,
          };
    default:
      return {
        target: null,
        requestedTargetType,
        extraInstruction,
        handoffRequested,
        handoffInstruction,
      };
  }
}

export function createReviewExtension(options: CreateReviewExtensionOptions = { enabled: true }) {
  return function reviewExtension(pi: ExtensionAPI): void {
    if (options.enabled === false) {
      return;
    }

    installChildBootstrap(pi);

    const defaultSubagentHooks = createDefaultSubagentRuntimeHooks(pi);
    const reviewSubagentHooks = {
      ...defaultSubagentHooks,
      emitStatusMessage({ content }: { content: string; triggerTurn?: boolean }) {
        pi.sendMessage(
          {
            customType: SUBAGENT_STATUS_MESSAGE,
            content,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
      },
    };

    async function generateReviewHandoff(input: {
      ctx: ExtensionCommandContext;
      goal: string;
      messages: ReturnType<typeof getConversationMessages>;
    }): Promise<SummaryGenerationResult> {
      if (options.handoffGenerator) {
        return options.handoffGenerator(input);
      }

      return input.ctx.hasUI
        ? await generateContextTransferSummaryWithLoader(
            input.ctx,
            input.goal,
            input.messages,
            "Generating review handoff...",
          )
        : await generateContextTransferSummary(input.ctx, input.goal, input.messages);
    }

    const adapter =
      options.adapterFactory?.(pi) ??
      new TmuxAdapter(
        (command, args, execOptions) => pi.exec(command, args, execOptions),
        process.cwd(),
      );
    let sdk = createSubagentSDK(pi, {
      adapter,
      buildLaunchCommand,
      hooks: reviewSubagentHooks,
    });
    let stopSdkEvents: (() => void) | undefined;

    const runtime = {
      ctx: undefined as ExtensionContext | undefined,
      active: false,
      subagentSessionId: undefined as string | undefined,
      targetLabel: undefined as string | undefined,
      checkoutToRestore: undefined as ReviewCheckoutTarget | undefined,
      customInstructions: undefined as string | undefined,
      completionNotifiedSessionId: undefined as string | undefined,
    };

    function buildAddressReviewPrompt(summary: string): string {
      return `${REVIEW_ADDRESS_FINDINGS_PROMPT}\n\n## Review Summary\n${summary.trim()}`;
    }

    async function offerCompletionActions(ctx: ExtensionContext, summary: string): Promise<void> {
      if (!ctx.hasUI || !summary.trim()) {
        return;
      }

      const prompt = buildAddressReviewPrompt(summary);
      while (true) {
        const selectedAction = options.completionActionPicker
          ? await options.completionActionPicker({ ctx, summary })
          : await (async () => {
              const choice = await ctx.ui.select("Review subagent finished:", [
                "Copy review summary",
                "Address the review",
                "Fork and address the review",
              ]);
              if (choice === undefined) {
                return undefined;
              }

              if (choice === "Copy review summary") {
                return "copy";
              }

              return choice === "Address the review" ? "address" : "fork";
            })();
        if (selectedAction === undefined) {
          return;
        }

        if (selectedAction === "copy") {
          try {
            await (options.clipboardWriter ?? copyTextToClipboard)(summary);
            ctx.ui.notify("Copied review summary to clipboard.", "info");
          } catch (error) {
            ctx.ui.notify(
              `Failed to copy review summary: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
          continue;
        }

        if (selectedAction === "address") {
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
          return;
        }

        let branchFromId = ctx.sessionManager.getLeafId() ?? undefined;
        if (!branchFromId) {
          pi.appendEntry(REVIEW_ANCHOR_TYPE, { createdAt: new Date().toISOString() });
          branchFromId = ctx.sessionManager.getLeafId() ?? undefined;
        }
        if (!branchFromId) {
          ctx.ui.notify("Failed to create a branch for addressing the review.", "error");
          return;
        }

        try {
          const result = await ctx.navigateTree(branchFromId, {
            summarize: false,
            label: "review-fixes",
          });
          if (result.cancelled) {
            return;
          }
        } catch (error) {
          ctx.ui.notify(
            `Failed to create review fix branch: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return;
        }

        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        return;
      }
    }

    async function finalizeReview(
      ctx: ExtensionContext,
      status: "completed" | "failed" | "cancelled",
      summary?: string,
    ): Promise<void> {
      const checkoutToRestore = runtime.checkoutToRestore;
      clearReviewState(ctx);

      const restoreResult = await restoreCheckoutTarget(pi, checkoutToRestore);
      if (!restoreResult.success) {
        ctx.ui.notify(`Failed to restore checkout: ${restoreResult.error}`, "error");
      }

      ctx.ui.notify(
        status === "completed"
          ? "Review complete."
          : status === "cancelled"
            ? "Review cancelled."
            : "Review failed.",
        status === "completed" ? "info" : "warning",
      );

      if (status === "completed" && summary?.trim()) {
        await offerCompletionActions(ctx, summary);
      }
    }

    function attachSdkEvents(): void {
      stopSdkEvents?.();
      stopSdkEvents = sdk.onEvent((event) => {
        if (!runtime.subagentSessionId || event.state.sessionId !== runtime.subagentSessionId) {
          return;
        }

        const ctx = runtime.ctx;
        if (!ctx) {
          return;
        }

        syncReviewWidget(ctx);
        if (
          ["completed", "failed", "cancelled"].includes(event.state.status) &&
          runtime.completionNotifiedSessionId !== event.state.sessionId
        ) {
          runtime.completionNotifiedSessionId = event.state.sessionId;
          void finalizeReview(ctx, event.state.status, event.state.summary);
        }
      });
    }

    function resetSdk(): void {
      stopSdkEvents?.();
      stopSdkEvents = undefined;
      sdk.dispose();
      sdk = createSubagentSDK(pi, {
        adapter,
        buildLaunchCommand,
        hooks: reviewSubagentHooks,
      });
      attachSdkEvents();
    }

    attachSdkEvents();

    function persistReviewSettings(): void {
      pi.appendEntry(REVIEW_SETTINGS_TYPE, {
        customInstructions: runtime.customInstructions,
      } satisfies ReviewSettingsState);
    }

    function setReviewCustomInstructions(instructions: string | undefined): void {
      runtime.customInstructions = instructions?.trim() || undefined;
      persistReviewSettings();
    }

    function trackedReviewState() {
      if (!runtime.subagentSessionId) {
        return undefined;
      }

      return sdk.get(runtime.subagentSessionId)?.getState();
    }

    function reviewStatusText(): string | undefined {
      const state = trackedReviewState();
      if (!state) {
        return undefined;
      }

      if (state.status === "running") {
        return "running";
      }
      if (state.status === "idle") {
        return "waiting for completion summary";
      }
      if (state.status === "completed") {
        return "completing";
      }
      if (state.status === "failed") {
        return "failed, review output captured";
      }
      if (state.status === "cancelled") {
        return "cancelled";
      }

      return state.status;
    }

    function syncReviewWidget(ctx: ExtensionContext): void {
      if (!runtime.active) {
        setReviewWidget(ctx, undefined);
        return;
      }

      setReviewWidget(ctx, {
        targetLabel: runtime.targetLabel,
        statusText: reviewStatusText(),
      });
    }

    function applyReviewSettings(ctx: ExtensionContext): void {
      runtime.customInstructions = getReviewSettings(ctx).customInstructions;
    }

    function applyReviewState(ctx: ExtensionContext): void {
      const previousSessionId = runtime.subagentSessionId;
      const state = getReviewState(ctx);
      const activeState = isReviewStateActiveOnBranch(state, ctx.sessionManager.getBranch())
        ? state
        : undefined;
      runtime.active = Boolean(activeState?.active);
      runtime.subagentSessionId = activeState?.subagentSessionId;
      runtime.targetLabel = activeState?.targetLabel;
      runtime.checkoutToRestore = activeState?.checkoutToRestore;
      if (previousSessionId && previousSessionId !== runtime.subagentSessionId) {
        resetSdk();
      }
      if (!activeState?.active) {
        runtime.completionNotifiedSessionId = undefined;
      }
      syncReviewWidget(ctx);
    }

    async function restoreTrackedReviewSubagent(ctx: ExtensionContext): Promise<void> {
      if (!runtime.subagentSessionId || sdk.get(runtime.subagentSessionId)) {
        return;
      }

      if (isChildSession(readChildState(), ctx)) {
        return;
      }

      await sdk.restore(ctx);
    }

    async function applyAllReviewState(ctx: ExtensionContext): Promise<void> {
      runtime.ctx = ctx;
      applyReviewSettings(ctx);
      applyReviewState(ctx);
      try {
        await restoreTrackedReviewSubagent(ctx);
      } catch {
        return;
      }
      syncReviewWidget(ctx);
      if (runtime.active && isTrackedReviewTerminal()) {
        const terminalState = trackedReviewState();
        if (
          terminalState &&
          ["completed", "failed", "cancelled"].includes(terminalState.status) &&
          runtime.completionNotifiedSessionId !== terminalState.sessionId
        ) {
          runtime.completionNotifiedSessionId = terminalState.sessionId;
          void finalizeReview(ctx, terminalState.status, terminalState.summary);
        }
      }
    }

    function persistReviewState(state: ReviewSessionState): void {
      pi.appendEntry(REVIEW_STATE_TYPE, state);
    }

    function clearReviewState(ctx: ExtensionContext): void {
      resetSdk();
      runtime.active = false;
      runtime.subagentSessionId = undefined;
      runtime.targetLabel = undefined;
      runtime.checkoutToRestore = undefined;
      runtime.completionNotifiedSessionId = undefined;
      persistReviewState({ active: false });
      syncReviewWidget(ctx);
    }

    function isTrackedReviewTerminal(): boolean {
      const state = trackedReviewState();
      return Boolean(state && ["completed", "failed", "cancelled"].includes(state.status));
    }

    async function ensureGithubCliReady(ctx: ExtensionContext): Promise<boolean> {
      const version = await pi.exec("gh", ["--version"]);
      if (version.code !== 0) {
        ctx.ui.notify(`PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}`, "error");
        return false;
      }

      const authStatus = await pi.exec("gh", ["auth", "status"]);
      if (authStatus.code !== 0) {
        ctx.ui.notify(
          "GitHub CLI is installed, but you're not signed in. Run `gh auth login`, then verify with `gh auth status`.",
          "error",
        );
        return false;
      }

      return true;
    }

    async function resolvePullRequestTarget(
      ctx: ExtensionContext,
      ref: string,
      resolveOptions: { skipInitialPendingChangesCheck?: boolean } = {},
    ): Promise<ReviewTarget | null> {
      if (!(await ensureGithubCliReady(ctx))) {
        return null;
      }

      if (!resolveOptions.skipInitialPendingChangesCheck && (await hasPendingChanges(pi))) {
        ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
        return null;
      }

      const parsedReference = parsePrReference(ref);
      if (!parsedReference) {
        ctx.ui.notify("Invalid PR reference. Enter a number or GitHub PR URL.", "error");
        return null;
      }
      const { prNumber, repo } = parsedReference;

      ctx.ui.notify(`Fetching PR #${prNumber} info...`, "info");
      const prInfo = await getPrInfo(pi, prNumber, repo);
      if (!prInfo) {
        ctx.ui.notify(
          `Could not fetch PR #${prNumber}. Make sure it exists and your GitHub auth has access.`,
          "error",
        );
        return null;
      }

      if (await hasPendingChanges(pi)) {
        ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
        return null;
      }

      const checkoutToRestore = await getCurrentCheckoutTarget(pi);
      if (!checkoutToRestore) {
        ctx.ui.notify("Failed to determine the current checkout before PR review.", "error");
        return null;
      }

      ctx.ui.notify(`Checking out PR #${prNumber}...`, "info");
      const checkoutResult = await checkoutPr(pi, prNumber, repo);
      if (!checkoutResult.success) {
        ctx.ui.notify(`Failed to checkout PR: ${checkoutResult.error}`, "error");
        return null;
      }

      ctx.ui.notify(`Checked out PR #${prNumber} (${prInfo.headBranch})`, "info");
      return {
        type: "pullRequest",
        prNumber,
        baseBranch: prInfo.baseBranch,
        title: prInfo.title,
        checkoutToRestore,
      };
    }

    async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
      if (await hasUncommittedChanges(pi)) {
        return "uncommitted";
      }

      const currentBranch = await getCurrentBranch(pi);
      const defaultBranch = await getDefaultBranch(pi);
      if (currentBranch && currentBranch !== defaultBranch) {
        return "baseBranch";
      }

      return "commit";
    }

    async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      const branches = await getLocalBranches(pi);
      const currentBranch = await getCurrentBranch(pi);
      const defaultBranch = await getDefaultBranch(pi);
      const candidateBranches = currentBranch
        ? branches.filter((branch) => branch !== currentBranch)
        : branches;
      if (candidateBranches.length === 0) {
        ctx.ui.notify(
          currentBranch
            ? `No other branches found (current branch: ${currentBranch})`
            : "No branches found",
          "error",
        );
        return null;
      }

      const items: SelectItem[] = candidateBranches
        .slice()
        .sort((left, right) => {
          if (left === defaultBranch) return -1;
          if (right === defaultBranch) return 1;
          return left.localeCompare(right);
        })
        .map((branch) => ({
          value: branch,
          label: branch,
          description: branch === defaultBranch ? "(default)" : "",
        }));

      const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Select base branch"))));

        const searchInput = new Input();
        container.addChild(searchInput);
        container.addChild(new Spacer(1));

        const listContainer = new Container();
        container.addChild(listContainer);
        container.addChild(
          new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")),
        );
        container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

        let filteredItems = items;
        let selectList: SelectList | null = null;

        const updateList = () => {
          listContainer.clear();
          if (filteredItems.length === 0) {
            listContainer.addChild(new Text(theme.fg("warning", "  No matching branches")));
            selectList = null;
            return;
          }

          selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);
          listContainer.addChild(selectList);
        };

        const applyFilter = () => {
          const query = searchInput.getValue();
          filteredItems = query
            ? fuzzyFilter(
                items,
                query,
                (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
              )
            : items;
          updateList();
        };

        applyFilter();

        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            if (
              keybindings.matches(data, "tui.select.up") ||
              keybindings.matches(data, "tui.select.down") ||
              keybindings.matches(data, "tui.select.confirm") ||
              keybindings.matches(data, "tui.select.cancel")
            ) {
              if (selectList) {
                selectList.handleInput(data);
              } else if (keybindings.matches(data, "tui.select.cancel")) {
                done(null);
              }
              tui.requestRender();
              return;
            }

            searchInput.handleInput(data);
            applyFilter();
            tui.requestRender();
          },
        };
      });

      return result ? { type: "baseBranch", branch: result } : null;
    }

    async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
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

      const result = await ctx.ui.custom<{ sha: string; title: string } | null>(
        (tui, theme, keybindings, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Select commit to review"))));

          const searchInput = new Input();
          container.addChild(searchInput);
          container.addChild(new Spacer(1));

          const listContainer = new Container();
          container.addChild(listContainer);
          container.addChild(
            new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")),
          );
          container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

          let filteredItems = items;
          let selectList: SelectList | null = null;

          const updateList = () => {
            listContainer.clear();
            if (filteredItems.length === 0) {
              listContainer.addChild(new Text(theme.fg("warning", "  No matching commits")));
              selectList = null;
              return;
            }

            selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            });
            selectList.onSelect = (item) => {
              const commit = commits.find((candidate) => candidate.sha === item.value);
              done(commit ?? null);
            };
            selectList.onCancel = () => done(null);
            listContainer.addChild(selectList);
          };

          const applyFilter = () => {
            const query = searchInput.getValue();
            filteredItems = query
              ? fuzzyFilter(
                  items,
                  query,
                  (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
                )
              : items;
            updateList();
          };

          applyFilter();

          return {
            render(width: number) {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              if (
                keybindings.matches(data, "tui.select.up") ||
                keybindings.matches(data, "tui.select.down") ||
                keybindings.matches(data, "tui.select.confirm") ||
                keybindings.matches(data, "tui.select.cancel")
              ) {
                if (selectList) {
                  selectList.handleInput(data);
                } else if (keybindings.matches(data, "tui.select.cancel")) {
                  done(null);
                }
                tui.requestRender();
                return;
              }

              searchInput.handleInput(data);
              applyFilter();
              tui.requestRender();
            },
          };
        },
      );

      return result ? { type: "commit", sha: result.sha, title: result.title } : null;
    }

    async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      const result = await ctx.ui.editor(
        "Enter folders or files to review (space-separated or one per line):",
        ".",
      );
      if (!result?.trim()) {
        return null;
      }

      const paths = parseReviewPaths(result);
      return paths.length > 0 ? { type: "folder", paths } : null;
    }

    async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      if (await hasPendingChanges(pi)) {
        ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
        return null;
      }

      const prRef = await ctx.ui.editor(
        "Enter PR number or URL (for example 123 or https://github.com/owner/repo/pull/123):",
        "",
      );
      if (!prRef?.trim()) {
        return null;
      }

      return resolvePullRequestTarget(ctx, prRef, { skipInitialPendingChangesCheck: true });
    }

    async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
      const smartDefault = await getSmartDefault();
      const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
        value: preset.value,
        label: preset.label,
        description: preset.description,
      }));
      const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

      while (true) {
        const items: SelectItem[] = [
          ...presetItems,
          {
            value: TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
            label: runtime.customInstructions
              ? "Remove custom review instructions"
              : "Add custom review instructions",
            description: runtime.customInstructions
              ? "(currently set)"
              : "(applies to all review modes)",
          },
        ];

        const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Select a review preset"))));

          const selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });
          if (smartDefaultIndex >= 0) {
            selectList.setSelectedIndex(smartDefaultIndex);
          }

          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);

          container.addChild(selectList);
          container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to cancel")));
          container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

          return {
            render(width: number) {
              return container.render(width);
            },
            invalidate() {
              container.invalidate();
            },
            handleInput(data: string) {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        });

        if (!result) {
          return null;
        }

        if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
          if (runtime.customInstructions) {
            setReviewCustomInstructions(undefined);
            ctx.ui.notify("Custom review instructions removed", "info");
            continue;
          }

          const editedInstructions = await ctx.ui.editor(
            "Enter custom review instructions (applies to all review modes):",
            "",
          );
          if (!editedInstructions?.trim()) {
            ctx.ui.notify("Custom review instructions not changed", "info");
            continue;
          }

          setReviewCustomInstructions(editedInstructions);
          ctx.ui.notify("Custom review instructions saved", "info");
          continue;
        }

        if (result === "uncommitted") {
          return { type: "uncommitted" };
        }
        if (result === "baseBranch") {
          const target = await showBranchSelector(ctx);
          if (target) return target;
          continue;
        }
        if (result === "commit") {
          const target = await showCommitSelector(ctx);
          if (target) return target;
          continue;
        }
        if (result === "folder") {
          const target = await showFolderInput(ctx);
          if (target) return target;
          continue;
        }
        if (result === "pullRequest") {
          const target = await showPrInput(ctx);
          if (target) return target;
          continue;
        }
      }
    }

    async function executeReview(
      ctx: ExtensionCommandContext,
      target: ReviewTarget,
      options: {
        extraInstruction?: string;
        handoffRequested?: boolean;
        handoffInstruction?: string;
      } = {},
    ): Promise<boolean> {
      if (runtime.active) {
        ctx.ui.notify("A review is already running. Wait for it to finish first.", "warning");
        return false;
      }

      const checkoutToRestore =
        target.type === "pullRequest" ? target.checkoutToRestore : undefined;

      const prompt = await buildReviewPrompt(pi, target);
      const targetLabel = getUserFacingHint(target);
      const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);
      const parentSessionPath = ctx.sessionManager.getSessionFile();
      const parentMessages = getConversationMessages(ctx);

      let generatedHandoffPrompt: string | undefined;
      if (options.handoffRequested) {
        if (parentMessages.length > 0) {
          const handoffGoal = [
            `Prepare a reviewer handoff for reviewing ${targetLabel}.`,
            "Summarize the implementation intent, risky areas, tradeoffs, open questions, and anything the reviewer should challenge or validate.",
            options.handoffInstruction?.trim()
              ? `Additional author handoff request: ${options.handoffInstruction.trim()}`
              : undefined,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n\n");
          const handoffResult = await generateReviewHandoff({
            ctx,
            goal: handoffGoal,
            messages: parentMessages,
          });

          if (handoffResult.error) {
            ctx.ui.notify(REVIEW_HANDOFF_GENERATION_FAILED_MESSAGE, "error");
            ctx.ui.notify(handoffResult.error, "error");
            return false;
          }
          if (handoffResult.aborted || !handoffResult.summary) {
            ctx.ui.notify("Review cancelled", "info");
            return false;
          }

          generatedHandoffPrompt = buildReviewHandoffPrompt({
            summary: handoffResult.summary,
            targetLabel,
            handoffInstruction: options.handoffInstruction,
            parentSessionPath,
          });
        } else if (options.handoffInstruction?.trim()) {
          generatedHandoffPrompt = `## Task\n${buildReviewAuthorTask(targetLabel, options.handoffInstruction)}`;
        } else {
          ctx.ui.notify("No session history available for automatic review handoff.", "warning");
        }
      }

      const promptSections = [
        `Review target:\n- ${targetLabel}`,
        `Review instructions:\n${prompt}`,
        runtime.customInstructions?.trim()
          ? `Shared custom review instructions:\n${runtime.customInstructions.trim()}`
          : undefined,
        options.extraInstruction?.trim()
          ? `Additional user-provided review instruction:\n${options.extraInstruction.trim()}`
          : undefined,
        generatedHandoffPrompt ? `Author handoff:\n${generatedHandoffPrompt}` : undefined,
        projectGuidelines ? `Project review guidelines:\n${projectGuidelines}` : undefined,
      ].filter((value): value is string => Boolean(value));

      const fullPrompt = [
        "Please perform a code review using the built-in review mode.",
        ...promptSections,
        "Return findings in the required review format.",
      ].join("\n\n");

      pi.appendEntry(REVIEW_ANCHOR_TYPE, {
        targetLabel,
        createdAt: new Date().toISOString(),
      });
      const branchAnchorId = ctx.sessionManager.getLeafId() ?? undefined;

      ctx.ui.notify(`Starting review: ${targetLabel}`, "info");

      try {
        const started = await sdk.spawn(
          {
            name: "review",
            task: fullPrompt,
            mode: "review",
            cwd: ctx.cwd,
          },
          ctx,
        );

        runtime.active = true;
        runtime.subagentSessionId = started.handle.sessionId;
        runtime.targetLabel = targetLabel;
        runtime.checkoutToRestore = checkoutToRestore;
        runtime.completionNotifiedSessionId = undefined;
        persistReviewState({
          active: true,
          subagentSessionId: started.handle.sessionId,
          targetLabel,
          branchAnchorId,
          checkoutToRestore,
        });
        syncReviewWidget(ctx);
        return true;
      } catch (error) {
        const restoreResult = await restoreCheckoutTarget(pi, checkoutToRestore);
        if (!restoreResult.success) {
          ctx.ui.notify(`Failed to restore checkout: ${restoreResult.error}`, "error");
        }
        clearReviewState(ctx);
        ctx.ui.notify(
          `Failed to start review: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return false;
      }
    }

    async function resolveRequestedTarget(
      ctx: ExtensionCommandContext,
      requestedTargetType: ParsedReviewArgs["requestedTargetType"],
    ): Promise<ReviewTarget | null> {
      if (requestedTargetType === "uncommitted") {
        return { type: "uncommitted" };
      }
      if (requestedTargetType === "branch") {
        return showBranchSelector(ctx);
      }
      if (requestedTargetType === "commit") {
        return showCommitSelector(ctx);
      }
      if (requestedTargetType === "folder") {
        return showFolderInput(ctx);
      }
      if (requestedTargetType === "pr") {
        return showPrInput(ctx);
      }

      return null;
    }

    async function handlePrCheckout(
      ctx: ExtensionContext,
      ref: string,
    ): Promise<ReviewTarget | null> {
      return resolvePullRequestTarget(ctx, ref);
    }

    pi.on("session_start", async (_event, ctx) => {
      await applyAllReviewState(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
      await applyAllReviewState(ctx);
    });

    pi.on("session_shutdown", async () => {
      stopSdkEvents?.();
      sdk.dispose();
    });

    pi.registerCommand("review", {
      description: "Review code changes using the built-in review mode",
      getArgumentCompletions: (prefix) => getReviewArgumentCompletions(pi, prefix),
      handler: async (args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Review requires interactive mode", "error");
          return;
        }

        if (runtime.active) {
          ctx.ui.notify("A review is already running. Wait for it to finish first.", "warning");
          return;
        }

        const gitCheck = await pi.exec("git", ["rev-parse", "--git-dir"]);
        if (gitCheck.code !== 0) {
          ctx.ui.notify("Not a git repository", "error");
          return;
        }

        let target: ReviewTarget | null = null;
        let fromSelector = false;
        const parsed = parseArgs(args);
        if (parsed.error) {
          ctx.ui.notify(parsed.error, "error");
          return;
        }

        if (parsed.target) {
          if (parsed.target.type === "pr") {
            target = await handlePrCheckout(ctx, parsed.target.ref);
            if (!target) {
              ctx.ui.notify("PR review failed. Returning to review menu.", "warning");
            }
          } else {
            target = parsed.target;
          }
        }

        if (!target && parsed.requestedTargetType) {
          target = await resolveRequestedTarget(ctx, parsed.requestedTargetType);
        } else if (!target) {
          fromSelector = true;
        }

        while (true) {
          if (!target && fromSelector) {
            target = await showReviewSelector(ctx);
          }

          if (!target) {
            ctx.ui.notify("Review cancelled", "info");
            return;
          }

          const started = await executeReview(ctx, target, {
            extraInstruction: parsed.extraInstruction?.trim() || undefined,
            handoffRequested: parsed.handoffRequested,
            handoffInstruction: parsed.handoffInstruction?.trim() || undefined,
          });
          if (started) {
            return;
          }

          if (!fromSelector) {
            return;
          }

          target = null;
        }
      },
    });
  };
}

export default createReviewExtension();
