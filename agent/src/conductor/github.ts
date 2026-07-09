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
import { execLoggedGh, isNoChecksReportedError } from "./github-call-logging.js";
import { parseJsonValue } from "./json.js";
import {
  projectItemsQuery,
  projectMetadataQuery,
  UPDATE_PROJECT_STATUS_MUTATION,
} from "./github-queries.js";
import {
  markFeedbackHandledWithReaction,
  markFeedbackSeenWithReaction,
} from "./github-reactions.js";
import type {
  CommandExec,
  GitHubClient,
  GitHubRepository,
  ProjectMetadata,
  PullRequestSummary,
} from "./github-types.js";
import { mergeConflictFeedback } from "./merge-conflict-feedback.js";
import { noopConductorLogger, type ConductorLogger } from "./logging.js";
import { projectKey } from "./project-key.js";
import { type WorkItem, WorkItemSchema } from "./store/types.js";
const GH_COMMAND_TIMEOUT_MS = 30_000;
const CONDUCTOR_COMMENT_MARKER = "<!-- pi-conductor -->";
const PROJECT_METADATA_CACHE_TTL_MS = 5 * 60_000;
type ProjectOwnerKind = "organization" | "user";
type ProjectMetadataCacheEntry = { metadata: ProjectMetadata; expiresAtMs: number };

const GhUserSchema = Type.Object({ login: Type.String() });
const GhOwnerSchema = Type.Object({
  type: Type.Union([Type.Literal("Organization"), Type.Literal("User")]),
});
const GhRepoViewSchema = Type.Object({
  nameWithOwner: Type.String(),
  defaultBranchRef: Type.Object({ name: Type.String() }),
});
const GhGraphqlResponseSchema = Type.Object({ data: Type.Record(Type.String(), Type.Unknown()) });
const GhPullRequestSchema = Type.Object({
  number: Type.Number(),
  url: Type.String(),
  headRefName: Type.String(),
  state: Type.String(),
  isDraft: Type.Boolean(),
  mergedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  mergeable: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  mergeStateStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  closingIssuesReferences: Type.Optional(
    Type.Array(Type.Object({ number: Type.Number({ minimum: 1 }) })),
  ),
});
const GhPullRequestListSchema = Type.Array(GhPullRequestSchema);
export {
  parseGhIssueComments,
  parseGhPrChecks,
  parseGhPrViewFeedback,
  parseGhReviewComments,
} from "./github-feedback.js";
export { parseGhIssueView } from "./github-issue-view.js";
export type { PullRequestFeedback } from "./github-feedback.js";
export type {
  CommandExec,
  GitHubClient,
  GitHubRepository,
  ProjectMetadata,
  PullRequestSummary,
} from "./github-types.js";

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

export class GhGitHubClient implements GitHubClient {
  private authenticatedUser: string | undefined;
  private readonly repositories = new Map<string, GitHubRepository>();
  private readonly projectMetadata = new Map<string, ProjectMetadataCacheEntry>();
  private readonly projectOwnerKinds = new Map<string, ProjectOwnerKind>();

  constructor(
    private readonly exec: CommandExec = execCommand,
    private readonly logger: ConductorLogger = noopConductorLogger,
  ) {}

  async getAuthenticatedUser(): Promise<string> {
    if (this.authenticatedUser !== undefined) return this.authenticatedUser;
    await execLoggedGh({
      action: "gh auth status",
      args: ["auth", "status"],
      cwd: undefined,
      exec: this.exec,
      logger: this.logger,
      timeoutMs: GH_COMMAND_TIMEOUT_MS,
    });
    const stdout = await this.gh(["api", "user"], undefined, "gh api user");
    this.authenticatedUser = parseGhUser(stdout).login;
    return this.authenticatedUser;
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    const requestedKey = repositoryCacheKey(owner, repo);
    const cached = this.repositories.get(requestedKey);
    if (cached !== undefined) return cached;
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
    const repository = {
      owner: resolvedOwner,
      repo: resolvedRepo,
      defaultBranch: parsed.defaultBranchRef.name,
    };
    this.repositories.set(requestedKey, repository);
    this.repositories.set(repositoryCacheKey(resolvedOwner, resolvedRepo), repository);
    return repository;
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
    return projectItem;
  }

  async listProjectItems(repo: ManagedRepositoryConfig): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    let cursor: string | undefined;
    const ownerKind = await this.resolveProjectOwnerKind(repo.project.owner, repo.repoPath);
    while (true) {
      const page = parseProjectItemsGraphqlPage(
        await this.gh(
          [
            "api",
            "graphql",
            "-f",
            `query=${projectItemsQuery(ownerKind)}`,
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
        "-f",
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
        markConductorComment(body),
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
          "number,url,headRefName,state,isDraft,mergedAt,mergeable,mergeStateStatus,closingIssuesReferences",
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
    _ignoredAuthors: string[],
    pullRequest?: PullRequestSummary,
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
    const mergeConflict = await this.tryReadFeedback(async () =>
      mergeConflictFeedback(
        hasMergeabilityFields(pullRequest)
          ? pullRequest
          : await this.getPullRequest(owner, repo, prNumber),
      ),
    );
    return [
      ...mergeConflict,
      ...checks,
      ...viewFeedback,
      ...reviewComments,
      ...issueComments,
    ].filter((feedback) => !hasConductorMarker(feedback.body));
  }

  async markFeedbackSeen(
    _owner: string,
    _repo: string,
    feedback: PullRequestFeedback,
  ): Promise<void> {
    await markFeedbackSeenWithReaction((args, cwd, label) => this.gh(args, cwd, label), feedback);
  }

  async markFeedbackHandled(
    _owner: string,
    _repo: string,
    feedback: PullRequestFeedback,
  ): Promise<void> {
    await markFeedbackHandledWithReaction(
      (args, cwd, label) => this.gh(args, cwd, label),
      feedback,
    );
  }

  private async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestSummary> {
    return parseGhPullRequest(
      await this.gh(
        [
          "pr",
          "view",
          String(prNumber),
          "--repo",
          `${owner}/${repo}`,
          "--json",
          "number,url,headRefName,state,isDraft,mergedAt,mergeable,mergeStateStatus,closingIssuesReferences",
        ],
        undefined,
        "gh pr view merge state",
      ),
    );
  }

  private async resolveProjectItem(
    projectItemId: string,
    config: GlobalConductorConfig,
  ): Promise<WorkItem> {
    const projectItems = new Map<string, WorkItem[]>();
    for (const repo of config.repositories) {
      const key = projectKey(repo.project.owner, repo.project.number);
      const cached = projectItems.get(key);
      const items = cached ?? (await this.listProjectItems(repo));
      if (cached === undefined) projectItems.set(key, items);
      const item = items.find((entry) => entry.projectItemId === projectItemId);
      if (item !== undefined) return item;
    }
    throw new Error(`Project item is not managed by conductor: ${projectItemId}`);
  }

  private async getProjectMetadata(repo: ManagedRepositoryConfig): Promise<ProjectMetadata> {
    const key = projectKey(repo.project.owner, repo.project.number);
    const cached = this.projectMetadata.get(key);
    if (cached !== undefined && cached.expiresAtMs > Date.now()) return cached.metadata;
    const ownerKind = await this.resolveProjectOwnerKind(repo.project.owner, repo.repoPath);
    const stdout = await this.gh(
      [
        "api",
        "graphql",
        "-f",
        `query=${projectMetadataQuery(ownerKind)}`,
        "-F",
        `owner=${repo.project.owner}`,
        "-F",
        `number=${repo.project.number}`,
      ],
      repo.repoPath,
      "gh project metadata graphql",
    );
    const metadata = parseProjectMetadataGraphql(stdout);
    this.projectMetadata.set(key, {
      metadata,
      expiresAtMs: Date.now() + PROJECT_METADATA_CACHE_TTL_MS,
    });
    return metadata;
  }

  private async resolveProjectOwnerKind(owner: string, cwd: string): Promise<ProjectOwnerKind> {
    const cached = this.projectOwnerKinds.get(owner.toLowerCase());
    if (cached !== undefined) return cached;
    const parsed = Value.Parse(
      GhOwnerSchema,
      parseJsonValue(
        await this.gh(["api", `users/${owner}`], cwd, "gh project owner type"),
        "gh project owner type",
      ),
    );
    const ownerKind = parsed.type === "Organization" ? "organization" : "user";
    this.projectOwnerKinds.set(owner.toLowerCase(), ownerKind);
    return ownerKind;
  }

  private async listFailedChecks(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestFeedback[]> {
    try {
      return parseGhPrChecks(
        await this.gh(
          [
            "pr",
            "checks",
            String(prNumber),
            "--repo",
            `${owner}/${repo}`,
            "--json",
            "name,state,link,bucket,completedAt,startedAt",
          ],
          undefined,
          "gh pr checks",
          isNoChecksReportedError,
        ),
      );
    } catch (error) {
      if (isNoChecksReportedError(error)) return [];
      throw error;
    }
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

  private async gh(
    args: string[],
    cwd: string | undefined,
    _action: string,
    isExpectedFailure?: (error: unknown) => boolean,
  ): Promise<string> {
    const result = await execLoggedGh({
      action: _action,
      args,
      cwd,
      exec: this.exec,
      isExpectedFailure,
      logger: this.logger,
      timeoutMs: GH_COMMAND_TIMEOUT_MS,
    });
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

export function parseGhPullRequestList(stdout: string): PullRequestSummary[] {
  return Value.Parse(GhPullRequestListSchema, parseJsonValue(stdout, "gh pr list")).map((pr) =>
    normalizePullRequestSummary(pr),
  );
}

export function parseGhPullRequest(stdout: string): PullRequestSummary {
  return normalizePullRequestSummary(
    Value.Parse(GhPullRequestSchema, parseJsonValue(stdout, "gh pr view")),
  );
}

function normalizePullRequestSummary(pr: Static<typeof GhPullRequestSchema>): PullRequestSummary {
  return {
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName,
    state: pr.state,
    isDraft: pr.isDraft,
    ...(pr.mergedAt === undefined || pr.mergedAt === null ? {} : { mergedAt: pr.mergedAt }),
    ...(pr.mergeable === undefined || pr.mergeable === null ? {} : { mergeable: pr.mergeable }),
    ...(pr.mergeStateStatus === undefined || pr.mergeStateStatus === null
      ? {}
      : { mergeStateStatus: pr.mergeStateStatus }),
    ...(pr.closingIssuesReferences === undefined
      ? {}
      : { linkedIssueNumbers: pr.closingIssuesReferences.map((issue) => issue.number) }),
  };
}

function hasMergeabilityFields(pr: PullRequestSummary | undefined): pr is PullRequestSummary {
  return pr?.mergeable !== undefined || pr?.mergeStateStatus !== undefined;
}

function repositoryCacheKey(owner: string, repo: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
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
  const issueState = readString(content.state);
  const title = readString(content.title);
  const url = readString(content.url);
  const projectItemId = readString(item.id);
  if (
    owner === undefined ||
    repo === undefined ||
    issueNumber === undefined ||
    (issueState !== "OPEN" && issueState !== "CLOSED") ||
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
      issueState,
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

function hasConductorMarker(body: string): boolean {
  return (
    hasExplicitConductorMarker(body) ||
    /^pi conductor (associated pr|stopped run|blocked run|completed run)/iu.test(body)
  );
}

function markConductorComment(body: string): string {
  if (hasExplicitConductorMarker(body)) return body;
  return `${body}\n\n${CONDUCTOR_COMMENT_MARKER}`;
}

function hasExplicitConductorMarker(body: string): boolean {
  return body.toLowerCase().includes(CONDUCTOR_COMMENT_MARKER);
}

function readNodes(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
