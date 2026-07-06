import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { asRecord, readNumber, readString } from "../utils/unknown-data.js";
import type { ManagedRepositoryConfig } from "./config.js";
import {
  findManagedRepository,
  findManagedRepositoryByPath,
  type GlobalConductorConfig,
} from "./config.js";
import { execCommand } from "./exec.js";
import {
  parseGhIssueComments,
  parseGhPrChecks,
  parseGhPrViewFeedback,
  parseGhReviewComments,
  type PullRequestFeedback,
} from "./github-feedback.js";
import { parseJsonValue } from "./json.js";
import {
  PROJECT_ITEMS_QUERY,
  PROJECT_METADATA_QUERY,
  UPDATE_PROJECT_STATUS_MUTATION,
} from "./github-queries.js";
import { type WorkItem, WorkItemSchema } from "./store/types.js";
const GH_COMMAND_TIMEOUT_MS = 30_000;

const GhUserSchema = Type.Object({ login: Type.String() });
const GhRepoViewSchema = Type.Object({
  nameWithOwner: Type.String(),
  defaultBranchRef: Type.Object({ name: Type.String() }),
});
const GhIssueViewSchema = Type.Object({
  id: Type.Optional(Type.String()),
  number: Type.Number({ minimum: 1 }),
  title: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  url: Type.String(),
  labels: Type.Array(Type.Object({ name: Type.String() })),
  assignees: Type.Array(Type.Object({ login: Type.String() })),
});
const GhGraphqlResponseSchema = Type.Object({ data: Type.Record(Type.String(), Type.Unknown()) });
const GhPullRequestListSchema = Type.Array(
  Type.Object({
    number: Type.Number(),
    url: Type.String(),
    headRefName: Type.String(),
    state: Type.String(),
    isDraft: Type.Boolean(),
    mergedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    closingIssuesReferences: Type.Optional(
      Type.Array(Type.Object({ number: Type.Number({ minimum: 1 }) })),
    ),
  }),
);
export {
  parseGhIssueComments,
  parseGhPrChecks,
  parseGhPrViewFeedback,
  parseGhReviewComments,
} from "./github-feedback.js";
export type { PullRequestFeedback } from "./github-feedback.js";

export const IssueReferenceSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("issue"),
    owner: Type.String(),
    repo: Type.String(),
    number: Type.Number(),
  }),
  Type.Object({ kind: Type.Literal("issue-number"), number: Type.Number() }),
  Type.Object({ kind: Type.Literal("project-item"), projectItemId: Type.String() }),
]);

export type IssueReference = Static<typeof IssueReferenceSchema>;

export type GitHubRepository = {
  owner: string;
  repo: string;
  defaultBranch: string;
};

export type PullRequestSummary = {
  number: number;
  url: string;
  headRefName: string;
  state: string;
  isDraft: boolean;
  mergedAt?: string;
  linkedIssueNumbers?: number[];
};

export type ProjectMetadata = {
  projectId: string;
  fields: Map<string, { fieldId: string; options: Map<string, string> }>;
};

export interface GitHubClient {
  getAuthenticatedUser(): Promise<string>;
  getRepository(owner: string, repo: string): Promise<GitHubRepository>;
  resolveWorkItem(reference: string, config: GlobalConductorConfig, cwd: string): Promise<WorkItem>;
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
  listPullRequestFeedback(
    owner: string,
    repo: string,
    prNumber: number,
    issueNumber: number,
    ignoredAuthors: string[],
  ): Promise<PullRequestFeedback[]>;
}

export type CommandExec = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export class GhGitHubClient implements GitHubClient {
  constructor(private readonly exec: CommandExec = execCommand) {}

  async getAuthenticatedUser(): Promise<string> {
    await this.exec("gh", ["auth", "status"], { timeout: 5000 });
    const stdout = await this.gh(["api", "user"], undefined, "gh api user");
    return parseGhUser(stdout).login;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    const parsed = parseGhRepoView(
      await this.gh(
        ["repo", "view", `${owner}/${repo}`, "--json", "nameWithOwner,defaultBranchRef"],
        undefined,
        "gh repo view",
      ),
    );
    const [resolvedOwner, resolvedRepo] = parsed.nameWithOwner.split("/");
    if (resolvedOwner === undefined || resolvedRepo === undefined) {
      throw new Error(`gh repo view returned invalid nameWithOwner: ${parsed.nameWithOwner}`);
    }
    return {
      owner: resolvedOwner,
      repo: resolvedRepo,
      defaultBranch: parsed.defaultBranchRef.name,
    };
  }

  async resolveWorkItem(
    reference: string,
    config: GlobalConductorConfig,
    cwd: string,
  ): Promise<WorkItem> {
    const parsed = parseIssueReference(reference);
    if (parsed.kind === "project-item") {
      return this.resolveProjectItem(parsed.projectItemId, config);
    }

    const repoConfig = resolveReferenceRepository(parsed, config, cwd);
    const issueNumber = parsed.kind === "issue" ? parsed.number : parsed.number;
    const issue = await this.getIssue(repoConfig.owner, repoConfig.repo, issueNumber);
    const projectItem = (await this.listProjectItems(repoConfig)).find(
      (item) =>
        item.owner === repoConfig.owner &&
        item.repo === repoConfig.repo &&
        item.issueNumber === issueNumber,
    );
    if (projectItem === undefined) {
      throw new Error(
        `${repoConfig.owner}/${repoConfig.repo}#${issueNumber} is not linked to configured project ${repoConfig.project.owner}/${repoConfig.project.number}`,
      );
    }
    return {
      ...projectItem,
      issueId: issue.issueId,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
      assignees: issue.assignees,
      projectItemId: projectItem.projectItemId,
      projectId: projectItem.projectId,
    };
  }

  async listProjectItems(repo: ManagedRepositoryConfig): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    let cursor: string | undefined;
    while (true) {
      const page = parseProjectItemsGraphqlPage(
        await this.gh(
          [
            "api",
            "graphql",
            "-f",
            `query=${PROJECT_ITEMS_QUERY}`,
            "-F",
            `owner=${repo.project.owner}`,
            "-F",
            `number=${repo.project.number}`,
            ...(cursor === undefined ? [] : ["-F", `cursor=${cursor}`]),
          ],
          repo.repoPath,
          "gh project items graphql",
        ),
        repo.statusField ?? "Status",
      );
      items.push(...page.items);
      if (!page.hasNextPage || page.endCursor === undefined) return items;
      cursor = page.endCursor;
    }
  }

  async updateProjectStatus(
    repo: ManagedRepositoryConfig,
    workItem: WorkItem,
    statusName: string,
  ): Promise<void> {
    const metadata = await this.getProjectMetadata(repo);
    const statusField = metadata.fields.get(repo.statusField ?? "Status");
    const optionId = statusField?.options.get(statusName);
    if (statusField === undefined || optionId === undefined) {
      throw new Error(
        `Project status option not found: field ${repo.statusField ?? "Status"}, option ${statusName}`,
      );
    }
    await this.gh(
      [
        "api",
        "graphql",
        "-f",
        `query=${UPDATE_PROJECT_STATUS_MUTATION}`,
        "-F",
        `projectId=${metadata.projectId}`,
        "-F",
        `itemId=${workItem.projectItemId}`,
        "-F",
        `fieldId=${statusField.fieldId}`,
        "-F",
        `optionId=${optionId}`,
      ],
      repo.repoPath,
      "gh project status update",
    );
  }

  async commentIssue(workItem: WorkItem, body: string): Promise<void> {
    await this.gh(
      [
        "issue",
        "comment",
        String(workItem.issueNumber),
        "--repo",
        `${workItem.owner}/${workItem.repo}`,
        "--body",
        body,
      ],
      undefined,
      "gh issue comment",
    );
  }

  async findPullRequestByBranch(
    owner: string,
    repo: string,
    branch: string,
  ): Promise<PullRequestSummary | undefined> {
    const parsed = parseGhPullRequestList(
      await this.gh(
        [
          "pr",
          "list",
          "--repo",
          `${owner}/${repo}`,
          "--head",
          branch,
          "--state",
          "all",
          "--json",
          "number,url,headRefName,state,isDraft,mergedAt,closingIssuesReferences",
        ],
        undefined,
        "gh pr list",
      ),
    );
    return selectPullRequestSummary(parsed);
  }

  async listPullRequestFeedback(
    owner: string,
    repo: string,
    prNumber: number,
    issueNumber: number,
    ignoredAuthors: string[],
  ): Promise<PullRequestFeedback[]> {
    const checks = await this.tryReadFeedback(() => this.listFailedChecks(owner, repo, prNumber));
    const viewFeedback = await this.tryReadFeedback(() =>
      this.listViewFeedback(owner, repo, prNumber),
    );
    const reviewComments = await this.tryReadFeedback(() =>
      this.listReviewComments(owner, repo, prNumber),
    );
    const issueComments = await this.tryReadFeedback(() =>
      this.listIssueComments(owner, repo, issueNumber),
    );
    return [...checks, ...viewFeedback, ...reviewComments, ...issueComments].filter(
      (feedback) =>
        !isIgnoredFeedbackAuthor(feedback, ignoredAuthors) && !hasConductorMarker(feedback.body),
    );
  }

  private async getIssue(owner: string, repo: string, issueNumber: number): Promise<WorkItem> {
    const parsed = parseGhIssueView(
      await this.gh(
        [
          "issue",
          "view",
          String(issueNumber),
          "--repo",
          `${owner}/${repo}`,
          "--json",
          "id,number,title,body,url,labels,assignees",
        ],
        undefined,
        "gh issue view",
      ),
    );
    return Value.Parse(WorkItemSchema, {
      projectItemId: "",
      owner,
      repo,
      issueId: parsed.id,
      issueNumber: parsed.number,
      issueUrl: parsed.url,
      title: parsed.title,
      body: parsed.body ?? "",
      labels: parsed.labels.map((label) => label.name),
      assignees: parsed.assignees.map((assignee) => assignee.login),
      projectFields: {},
    });
  }

  private async resolveProjectItem(
    projectItemId: string,
    config: GlobalConductorConfig,
  ): Promise<WorkItem> {
    for (const repo of config.repositories) {
      const item = (await this.listProjectItems(repo)).find(
        (entry) => entry.projectItemId === projectItemId,
      );
      if (item !== undefined) return item;
    }
    throw new Error(`Project item is not managed by conductor: ${projectItemId}`);
  }

  private async getProjectMetadata(repo: ManagedRepositoryConfig): Promise<ProjectMetadata> {
    const stdout = await this.gh(
      [
        "api",
        "graphql",
        "-f",
        `query=${PROJECT_METADATA_QUERY}`,
        "-F",
        `owner=${repo.project.owner}`,
        "-F",
        `number=${repo.project.number}`,
      ],
      repo.repoPath,
      "gh project metadata graphql",
    );
    return parseProjectMetadataGraphql(stdout);
  }

  private async listFailedChecks(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestFeedback[]> {
    return parseGhPrChecks(
      await this.gh(
        [
          "pr",
          "checks",
          String(prNumber),
          "--repo",
          `${owner}/${repo}`,
          "--json",
          "name,state,conclusion,link,bucket,completedAt,startedAt",
        ],
        undefined,
        "gh pr checks",
      ),
    );
  }

  private async listViewFeedback(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestFeedback[]> {
    return parseGhPrViewFeedback(
      await this.gh(
        [
          "pr",
          "view",
          String(prNumber),
          "--repo",
          `${owner}/${repo}`,
          "--json",
          "comments,reviews,reviewDecision",
        ],
        undefined,
        "gh pr view",
      ),
    );
  }

  private async listReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestFeedback[]> {
    return parseGhReviewComments(
      await this.gh(
        ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/pulls/${prNumber}/comments`],
        undefined,
        "gh pr review comments",
      ),
    );
  }

  private async listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<PullRequestFeedback[]> {
    return parseGhIssueComments(
      await this.gh(
        ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/issues/${issueNumber}/comments`],
        undefined,
        "gh issue comments",
      ),
    );
  }

  private async tryReadFeedback(
    read: () => Promise<PullRequestFeedback[]>,
  ): Promise<PullRequestFeedback[]> {
    try {
      return await read();
    } catch {
      return [];
    }
  }

  private async gh(args: string[], cwd: string | undefined, _action: string): Promise<string> {
    const result = await this.exec("gh", args, { cwd, timeout: GH_COMMAND_TIMEOUT_MS });
    return result.stdout.trim();
  }
}

export function parseIssueReference(reference: string): IssueReference {
  const trimmed = reference.trim();
  const urlMatch = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\b|$)/u.exec(
    trimmed,
  );
  if (urlMatch?.[1] !== undefined && urlMatch[2] !== undefined && urlMatch[3] !== undefined) {
    return Value.Parse(IssueReferenceSchema, {
      kind: "issue",
      owner: urlMatch[1],
      repo: urlMatch[2],
      number: Number(urlMatch[3]),
    });
  }

  const repoIssueMatch = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/u.exec(trimmed);
  if (
    repoIssueMatch?.[1] !== undefined &&
    repoIssueMatch[2] !== undefined &&
    repoIssueMatch[3] !== undefined
  ) {
    return Value.Parse(IssueReferenceSchema, {
      kind: "issue",
      owner: repoIssueMatch[1],
      repo: repoIssueMatch[2],
      number: Number(repoIssueMatch[3]),
    });
  }

  const issueNumberMatch = /^#?(\d+)$/u.exec(trimmed);
  if (issueNumberMatch?.[1] !== undefined) {
    return Value.Parse(IssueReferenceSchema, {
      kind: "issue-number",
      number: Number(issueNumberMatch[1]),
    });
  }

  return Value.Parse(IssueReferenceSchema, { kind: "project-item", projectItemId: trimmed });
}

export function parseGhUser(stdout: string): Static<typeof GhUserSchema> {
  return Value.Parse(GhUserSchema, parseJsonValue(stdout, "gh api user"));
}

export function parseGhRepoView(stdout: string): Static<typeof GhRepoViewSchema> {
  return Value.Parse(GhRepoViewSchema, parseJsonValue(stdout, "gh repo view"));
}

export function parseGhIssueView(stdout: string): Static<typeof GhIssueViewSchema> {
  return Value.Parse(GhIssueViewSchema, parseJsonValue(stdout, "gh issue view"));
}

export function parseGhPullRequestList(stdout: string): PullRequestSummary[] {
  return Value.Parse(GhPullRequestListSchema, parseJsonValue(stdout, "gh pr list")).map((pr) => ({
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName,
    state: pr.state,
    isDraft: pr.isDraft,
    ...(pr.mergedAt === undefined || pr.mergedAt === null ? {} : { mergedAt: pr.mergedAt }),
    ...(pr.closingIssuesReferences === undefined
      ? {}
      : { linkedIssueNumbers: pr.closingIssuesReferences.map((issue) => issue.number) }),
  }));
}

export function parseProjectItemsGraphql(stdout: string, statusField = "Status"): WorkItem[] {
  return parseProjectItemsGraphqlPage(stdout, statusField).items;
}

export function parseProjectItemsGraphqlPage(
  stdout: string,
  statusField = "Status",
): { items: WorkItem[]; hasNextPage: boolean; endCursor?: string } {
  const response = Value.Parse(
    GhGraphqlResponseSchema,
    parseJsonValue(stdout, "gh project items graphql"),
  );
  const project = readProject(response.data);
  const projectId = readString(project.id);
  const items = asRecord(project.items);
  const itemNodes = readNodes(items?.nodes);
  const pageInfo = asRecord(items?.pageInfo);
  if (projectId === undefined) throw new Error("Project GraphQL response missing project id");

  return {
    items: itemNodes.flatMap((node) => normalizeProjectItem(node, projectId, statusField)),
    hasNextPage: pageInfo?.hasNextPage === true,
    ...(readString(pageInfo?.endCursor) === undefined
      ? {}
      : { endCursor: readString(pageInfo?.endCursor) }),
  };
}

export function parseProjectMetadataGraphql(stdout: string): ProjectMetadata {
  const response = Value.Parse(
    GhGraphqlResponseSchema,
    parseJsonValue(stdout, "gh project metadata graphql"),
  );
  const project = readProject(response.data);
  const projectId = readString(project.id);
  if (projectId === undefined) throw new Error("Project GraphQL response missing project id");

  const fields = new Map<string, { fieldId: string; options: Map<string, string> }>();
  for (const fieldNode of readNodes(asRecord(project.fields)?.nodes)) {
    const field = asRecord(fieldNode);
    const name = readString(field?.name);
    const fieldId = readString(field?.id);
    if (name === undefined || fieldId === undefined) continue;
    const options = new Map<string, string>();
    const optionNodes = Array.isArray(field?.options) ? field.options : [];
    for (const optionNode of optionNodes) {
      const option = asRecord(optionNode);
      const optionName = readString(option?.name);
      const optionId = readString(option?.id);
      if (optionName !== undefined && optionId !== undefined) options.set(optionName, optionId);
    }
    fields.set(name, { fieldId, options });
  }

  return { projectId, fields };
}

function resolveReferenceRepository(
  reference: Extract<IssueReference, { kind: "issue" | "issue-number" }>,
  config: GlobalConductorConfig,
  cwd: string,
): ManagedRepositoryConfig {
  if (reference.kind === "issue") {
    const repo = findManagedRepository(config, reference.owner, reference.repo);
    if (repo === undefined)
      throw new Error(`${reference.owner}/${reference.repo} is not managed by conductor`);
    return repo;
  }

  const repo =
    findManagedRepositoryByPath(config, cwd) ??
    (config.repositories.length === 1 ? config.repositories[0] : undefined);
  if (repo === undefined) {
    throw new Error(
      "Issue number reference requires current directory inside one managed repository",
    );
  }
  return repo;
}

function readProject(data: Record<string, unknown>): Record<string, unknown> {
  const organizationProject = asRecord(asRecord(data.organization)?.projectV2);
  if (organizationProject !== undefined) return organizationProject;
  const userProject = asRecord(asRecord(data.user)?.projectV2);
  if (userProject !== undefined) return userProject;
  throw new Error("Project GraphQL response did not include organization or user projectV2");
}

function normalizeProjectItem(node: unknown, projectId: string, statusField: string): WorkItem[] {
  const item = asRecord(node);
  const content = asRecord(item?.content);
  if (item === undefined || content === undefined) return [];
  const repository = asRecord(content.repository);
  const owner = readString(asRecord(repository?.owner)?.login);
  const repo = readString(repository?.name);
  const issueNumber = readNumber(content.number);
  const title = readString(content.title);
  const url = readString(content.url);
  const projectItemId = readString(item.id);
  if (
    owner === undefined ||
    repo === undefined ||
    issueNumber === undefined ||
    title === undefined ||
    url === undefined ||
    projectItemId === undefined
  ) {
    return [];
  }

  return [
    Value.Parse(WorkItemSchema, {
      projectItemId,
      projectId,
      owner,
      repo,
      issueId: readString(content.id),
      issueNumber,
      issueUrl: url,
      title,
      body: readString(content.body) ?? "",
      labels: readNameNodes(asRecord(content.labels)?.nodes),
      assignees: readLoginNodes(asRecord(content.assignees)?.nodes),
      projectStatus: readProjectStatus(item, statusField),
      projectFields: readProjectFields(item),
    }),
  ];
}

function readProjectStatus(item: Record<string, unknown>, statusField: string): string | undefined {
  const fields = readProjectFields(item);
  const status = fields[statusField];
  return typeof status === "string" ? status : undefined;
}

function readProjectFields(item: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const fieldValueNode of readNodes(asRecord(item.fieldValues)?.nodes)) {
    const fieldValue = asRecord(fieldValueNode);
    const fieldName = readString(asRecord(fieldValue?.field)?.name);
    if (fieldName === undefined) continue;
    const value =
      readString(fieldValue?.name) ??
      readString(fieldValue?.text) ??
      readString(fieldValue?.date) ??
      readNumber(fieldValue?.number);
    if (value !== undefined) result[fieldName] = value;
  }
  return result;
}

function readNameNodes(value: unknown): string[] {
  return readNodes(value).flatMap((node) => {
    const name = readString(asRecord(node)?.name);
    return name === undefined ? [] : [name];
  });
}

function readLoginNodes(value: unknown): string[] {
  return readNodes(value).flatMap((node) => {
    const login = readString(asRecord(node)?.login);
    return login === undefined ? [] : [login];
  });
}

function selectPullRequestSummary(prs: PullRequestSummary[]): PullRequestSummary | undefined {
  return (
    prs.find((pr) => pr.mergedAt !== undefined) ??
    prs.find((pr) => pr.state.toUpperCase() === "OPEN") ??
    prs[0]
  );
}

function isIgnoredFeedbackAuthor(feedback: PullRequestFeedback, ignoredAuthors: string[]): boolean {
  return feedback.author !== undefined && ignoredAuthors.includes(feedback.author);
}

function hasConductorMarker(body: string): boolean {
  const normalized = body.toLowerCase();
  return normalized.includes("pi-conductor") || normalized.includes("pi conductor");
}

function readNodes(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
