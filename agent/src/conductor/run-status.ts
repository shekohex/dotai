import { errorMessage } from "../utils/error-message.js";
import type {
  GlobalConductorConfig,
  ManagedRepositoryConfig,
  ResolvedRepositoryConfig,
} from "./config.js";
import { validateGlobalConfig } from "./config.js";
import type { PullRequestFeedback } from "./github-feedback.js";
import type { GitHubClient, PullRequestSummary } from "./github.js";
import type { HerdrSessionManager } from "./herdr.js";
import type { ConductorStore, LifecycleStatus, RunRecord, WorkItem } from "./store/types.js";
import type { WorktreeManager } from "./worktree.js";

export type ConductorOrchestratorDeps = {
  config: GlobalConductorConfig;
  store: ConductorStore;
  github: GitHubClient;
  herdr: HerdrSessionManager;
  worktrees?: WorktreeManager;
  cwd: string;
  now?: () => Date;
};

export type RunOptions = {
  launchFlags?: string[];
  configOverrides?: Partial<ManagedRepositoryConfig>;
};

export function assertGlobalConfigReady(config: GlobalConductorConfig): void {
  const errors = validateGlobalConfig(config);
  if (errors.length > 0) throw new Error(`Invalid conductor config:\n${errors.join("\n")}`);
}

export function isEligibleForAutomatedDispatch(
  workItem: WorkItem,
  dispatchLabel: string,
  authenticatedLogin: string,
): boolean {
  return (
    workItem.issueState === "OPEN" &&
    workItem.labels.includes(dispatchLabel) &&
    workItem.assignees.includes(authenticatedLogin)
  );
}

export async function hasRunStatusForWorkItem(
  store: ConductorStore,
  workItem: WorkItem,
  status: LifecycleStatus,
): Promise<boolean> {
  return (await store.listRuns()).some(
    (run) =>
      run.owner === workItem.owner &&
      run.repo === workItem.repo &&
      run.issueNumber === workItem.issueNumber &&
      run.status === status,
  );
}

export async function handleClosedWorkItem(input: {
  blockRun: (run: RunRecord) => Promise<void>;
  store: ConductorStore;
  workItem: WorkItem;
}): Promise<boolean> {
  if (input.workItem.issueState !== "CLOSED") return false;
  const active = await input.store.getActiveRun(
    input.workItem.owner,
    input.workItem.repo,
    input.workItem.issueNumber,
  );
  if (active !== undefined) await input.blockRun(active);
  return true;
}

export async function dispatchAutomatedWorkItem(input: {
  config: ResolvedRepositoryConfig;
  dispatch: () => Promise<RunRecord>;
  github: GitHubClient;
  workItem: WorkItem;
  worktrees: WorktreeManager;
}): Promise<RunRecord[]> {
  if (await hasMergedPullRequestForWorkItem(input)) return [];
  return [await input.dispatch()];
}

export async function reactToFeedbackBestEffort(input: {
  feedback: PullRequestFeedback;
  github: GitHubClient;
  record: (run: RunRecord, kind: string, payload: unknown) => Promise<void>;
  run: RunRecord;
  state: "seen" | "handled";
}): Promise<void> {
  try {
    if (input.state === "seen") {
      await input.github.markFeedbackSeen(input.run.owner, input.run.repo, input.feedback);
    } else {
      await input.github.markFeedbackHandled(input.run.owner, input.run.repo, input.feedback);
    }
    await input.record(input.run, "feedback_reaction", reactionEvent(input));
  } catch (error) {
    await input.record(input.run, "feedback_reaction_failed", {
      ...reactionEvent(input),
      error: errorMessage(error),
    });
  }
}

export async function hasMergedPullRequestForWorkItem(input: {
  config: ResolvedRepositoryConfig;
  github: GitHubClient;
  workItem: WorkItem;
  worktrees: WorktreeManager;
}): Promise<boolean> {
  const repository = await input.github.getRepository(input.config.owner, input.config.repo);
  const plan = input.worktrees.plan(input.config, input.workItem, repository.defaultBranch);
  const pr = await input.github.findPullRequestByBranch(
    input.workItem.owner,
    input.workItem.repo,
    plan.branch,
  );
  if (pr === undefined || !isPullRequestMerged(pr)) return false;
  return pullRequestMatchesIssue(pr, input.workItem.issueNumber);
}

export function isPullRequestMerged(pr: PullRequestSummary): boolean {
  return pr.mergedAt !== undefined || pr.state.toUpperCase() === "MERGED";
}

function pullRequestMatchesIssue(pr: PullRequestSummary, issueNumber: number): boolean {
  return (
    pr.linkedIssueNumbers === undefined ||
    pr.linkedIssueNumbers.length === 0 ||
    pr.linkedIssueNumbers.includes(issueNumber)
  );
}

function reactionEvent(input: {
  feedback: PullRequestFeedback;
  state: "seen" | "handled";
}): Record<string, unknown> {
  return { key: input.feedback.key, kind: input.feedback.kind, state: input.state };
}
