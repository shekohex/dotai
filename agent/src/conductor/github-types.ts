import type { ManagedRepositoryConfig, GlobalConductorConfig } from "./config.js";
import type { PullRequestFeedback } from "./github-feedback.js";
import type { WorkItem } from "./store/types.js";

export type GitHubRepository = {
  owner: string;
  repo: string;
  defaultBranch: string;
};

export type PullRequestSummary = {
  number: number;
  url: string;
  headRefName: string;
  baseRefName?: string;
  baseRefOid?: string;
  headRefOid?: string;
  state: string;
  isDraft: boolean;
  mergedAt?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  linkedIssueNumbers?: number[];
};

export type PullRequestSnapshot = {
  pullRequest?: PullRequestSummary;
  feedback: PullRequestFeedback[];
  feedbackComplete?: boolean;
};

export type ProjectMetadata = {
  projectId: string;
  fields: Map<string, { fieldId: string; options: Map<string, string> }>;
};

export type ProjectItemSnapshot = {
  project: {
    id: string;
    owner: string;
    number: number;
  };
  workItem: WorkItem;
};

export interface GitHubClient {
  getAuthenticatedUser(): Promise<string>;
  getRepository(owner: string, repo: string): Promise<GitHubRepository>;
  resolveWorkItem(reference: string, config: GlobalConductorConfig, cwd: string): Promise<WorkItem>;
  getProjectItem(projectItemId: string): Promise<ProjectItemSnapshot | undefined>;
  listProjectItems(repo: ManagedRepositoryConfig): Promise<WorkItem[]>;
  updateProjectStatus(
    repo: ManagedRepositoryConfig,
    workItem: WorkItem,
    statusName: string,
  ): Promise<void>;
  commentIssue(workItem: WorkItem, body: string): Promise<void>;
  findPullRequestByBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<PullRequestSummary | undefined>;
  getPullRequestSnapshot(input: {
    owner: string;
    repo: string;
    issueNumber: number;
    prNumber?: number;
    branch: string;
  }): Promise<PullRequestSnapshot>;
  getPullRequestMergeState(input: {
    owner: string;
    repo: string;
    prNumber?: number;
    branch: string;
  }): Promise<PullRequestSummary | undefined>;
  listPullRequestFeedback(
    owner: string,
    repo: string,
    prNumber: number,
    issueNumber: number,
    ignoredAuthors: string[],
    pullRequest?: PullRequestSummary,
  ): Promise<PullRequestFeedback[]>;
  markFeedbackSeen(owner: string, repo: string, feedback: PullRequestFeedback): Promise<void>;
  markFeedbackHandled(owner: string, repo: string, feedback: PullRequestFeedback): Promise<void>;
}

export type CommandExec = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;
