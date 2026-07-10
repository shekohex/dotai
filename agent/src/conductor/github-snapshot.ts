import { Type } from "typebox";
import { Value } from "typebox/value";

import { asRecord, readNumber, readString } from "../utils/unknown-data.js";
import { parseJsonValue } from "./json.js";
import {
  createCheckFeedbackKey,
  type PullRequestFeedback,
  PullRequestFeedbackSchema,
} from "./github-feedback.js";
import type { PullRequestSnapshot, PullRequestSummary } from "./github-types.js";
import { mergeConflictFeedback } from "./merge-conflict-feedback.js";

const GraphqlResponseSchema = Type.Object({ data: Type.Record(Type.String(), Type.Unknown()) });
export const PullRequestSnapshotSchema = Type.Object({
  pullRequest: Type.Optional(
    Type.Object({
      number: Type.Number(),
      url: Type.String(),
      headRefName: Type.String(),
      headRefOid: Type.Optional(Type.String()),
      baseRefName: Type.Optional(Type.String()),
      baseRefOid: Type.Optional(Type.String()),
      state: Type.String(),
      isDraft: Type.Boolean(),
      mergedAt: Type.Optional(Type.String()),
      mergeable: Type.Optional(Type.String()),
      mergeStateStatus: Type.Optional(Type.String()),
      linkedIssueNumbers: Type.Optional(Type.Array(Type.Number())),
    }),
  ),
  feedback: Type.Array(PullRequestFeedbackSchema),
  feedbackComplete: Type.Optional(Type.Boolean()),
});
const SNAPSHOT_FRAGMENT = `
fragment ConductorPullRequestSnapshot on PullRequest {
  number
  url
  headRefName
  headRefOid
  baseRefName
  baseRefOid
  state
  isDraft
  mergedAt
  mergeable
  mergeStateStatus
  reviewDecision
  closingIssuesReferences(first: 20) { nodes { number } }
  comments(last: 100) {
    nodes { id body url author { login } }
    pageInfo { hasPreviousPage }
  }
  reviews(last: 100) {
    nodes { id body url state author { login } }
    pageInfo { hasPreviousPage }
  }
  reviewThreads(last: 100) {
    nodes {
      comments(last: 100) {
        nodes { id body url author { login } }
        pageInfo { hasPreviousPage }
      }
    }
    pageInfo { hasPreviousPage }
  }
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              ... on CheckRun {
                id name status conclusion detailsUrl startedAt completedAt
              }
              ... on StatusContext {
                id context state targetUrl createdAt
              }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    }
  }
}`;

export function pullRequestSnapshotQuery(selector: "branch" | "number"): string {
  const pullRequestSelection =
    selector === "number"
      ? "pullRequest(number: $prNumber) { ...ConductorPullRequestSnapshot }"
      : `pullRequests(first: 100, headRefName: $branch, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ...ConductorPullRequestSnapshot }
        }`;
  const selectorVariable = selector === "number" ? "$prNumber: Int!" : "$branch: String!";
  return `
query($owner: String!, $repo: String!, $issueNumber: Int!, ${selectorVariable}) {
  repository(owner: $owner, name: $repo) {
    ${pullRequestSelection}
    issue(number: $issueNumber) {
      comments(last: 100) {
        nodes { id body url author { login } }
        pageInfo { hasPreviousPage }
      }
    }
  }
  rateLimit { cost limit remaining resetAt used }
}
${SNAPSHOT_FRAGMENT}`;
}

export function parsePullRequestSnapshotGraphql(stdout: string): PullRequestSnapshot {
  const response = Value.Parse(
    GraphqlResponseSchema,
    parseJsonValue(stdout, "gh pull request snapshot graphql"),
  );
  const repository = asRecord(response.data.repository);
  if (repository === undefined) return { feedback: [] };
  const pullRequest = selectPullRequest(repository);
  if (pullRequest === undefined) return { feedback: [] };
  const summary = normalizePullRequest(pullRequest);
  if (summary === undefined) return { feedback: [] };
  const issue = asRecord(repository.issue);
  return Value.Parse(PullRequestSnapshotSchema, {
    pullRequest: summary,
    feedbackComplete: hasCompleteFeedback(pullRequest, issue),
    feedback: [
      ...mergeConflictFeedback(summary),
      ...readCheckFeedback(pullRequest),
      ...readFeedbackConnection(pullRequest.comments, "comment"),
      ...readFeedbackConnection(pullRequest.reviews, "review"),
      ...readReviewThreadFeedback(pullRequest.reviewThreads),
      ...readFeedbackConnection(issue?.comments, "issue_comment"),
      ...readReviewDecisionFeedback(pullRequest),
    ].filter((feedback) => !hasConductorMarker(feedback.body)),
  });
}

function hasCompleteFeedback(
  pullRequest: Record<string, unknown>,
  issue: Record<string, unknown> | undefined,
): boolean {
  if (hasPreviousPage(pullRequest.comments) || hasPreviousPage(pullRequest.reviews)) return false;
  if (hasPreviousPage(issue?.comments) || hasPreviousPage(pullRequest.reviewThreads)) return false;
  for (const thread of readNodes(asRecord(pullRequest.reviewThreads)?.nodes)) {
    if (hasPreviousPage(asRecord(thread)?.comments)) return false;
  }
  const commits = readNodes(asRecord(pullRequest.commits)?.nodes);
  const commit = asRecord(asRecord(commits.at(-1))?.commit);
  const contexts = asRecord(asRecord(commit?.statusCheckRollup)?.contexts);
  return contexts?.pageInfo === undefined || asRecord(contexts.pageInfo)?.hasNextPage !== true;
}

function hasPreviousPage(value: unknown): boolean {
  return asRecord(asRecord(value)?.pageInfo)?.hasPreviousPage === true;
}

export function readGraphqlRateLimit(stdout: string): unknown {
  const response = Value.Parse(
    GraphqlResponseSchema,
    parseJsonValue(stdout, "GitHub GraphQL response"),
  );
  return response.data.rateLimit;
}

function selectPullRequest(
  repository: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const direct = asRecord(repository.pullRequest);
  if (direct !== undefined) return direct;
  const candidates = readNodes(asRecord(repository.pullRequests)?.nodes)
    .map((node) => asRecord(node))
    .filter((node): node is Record<string, unknown> => node !== undefined);
  return (
    candidates.find((node) => readString(node.mergedAt) !== undefined) ??
    candidates.find((node) => readString(node.state)?.toUpperCase() === "OPEN") ??
    candidates[0]
  );
}

function normalizePullRequest(node: Record<string, unknown>): PullRequestSummary | undefined {
  const number = readNumber(node.number);
  const url = readString(node.url);
  const headRefName = readString(node.headRefName);
  const state = readString(node.state);
  if (
    number === undefined ||
    url === undefined ||
    headRefName === undefined ||
    state === undefined
  ) {
    return undefined;
  }
  const mergedAt = readString(node.mergedAt);
  const headRefOid = readString(node.headRefOid);
  const baseRefName = readString(node.baseRefName);
  const baseRefOid = readString(node.baseRefOid);
  const mergeable = readString(node.mergeable);
  const mergeStateStatus = readString(node.mergeStateStatus);
  return {
    number,
    url,
    headRefName,
    ...(headRefOid === undefined ? {} : { headRefOid }),
    ...(baseRefName === undefined ? {} : { baseRefName }),
    ...(baseRefOid === undefined ? {} : { baseRefOid }),
    state,
    isDraft: node.isDraft === true,
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(mergeable === undefined ? {} : { mergeable }),
    ...(mergeStateStatus === undefined ? {} : { mergeStateStatus }),
    linkedIssueNumbers: readNodes(asRecord(node.closingIssuesReferences)?.nodes).flatMap(
      (entry) => {
        const issueNumber = readNumber(asRecord(entry)?.number);
        return issueNumber === undefined ? [] : [issueNumber];
      },
    ),
  };
}

function readReviewThreadFeedback(value: unknown): PullRequestFeedback[] {
  return readNodes(asRecord(value)?.nodes).flatMap((thread) =>
    readFeedbackConnection(asRecord(thread)?.comments, "review_comment"),
  );
}

function readFeedbackConnection(
  value: unknown,
  kind: PullRequestFeedback["kind"],
): PullRequestFeedback[] {
  return readNodes(asRecord(value)?.nodes).flatMap((node) => normalizeFeedback(node, kind));
}

function normalizeFeedback(
  value: unknown,
  kind: PullRequestFeedback["kind"],
): PullRequestFeedback[] {
  const node = asRecord(value);
  const body = readString(node?.body);
  if (node === undefined || body === undefined || body.trim().length === 0) return [];
  const id = readString(node.id) ?? readString(node.node_id) ?? readString(node.url) ?? body;
  const reactionSubjectId = readString(node.id) ?? readString(node.node_id);
  const url = readString(node.url);
  const author = readString(asRecord(node.author)?.login) ?? readString(asRecord(node.user)?.login);
  return [
    {
      key: `${kind}:${id}`,
      kind,
      body,
      ...(reactionSubjectId === undefined ? {} : { reactionSubjectId }),
      ...(url === undefined ? {} : { url }),
      ...(author === undefined ? {} : { author }),
      [kind]: {
        id,
        reactionSubjectId: reactionSubjectId ?? "",
        body,
        url: url ?? "",
        author: author ?? "",
      },
    },
  ];
}

function readReviewDecisionFeedback(pullRequest: Record<string, unknown>): PullRequestFeedback[] {
  if (readString(pullRequest.reviewDecision) !== "CHANGES_REQUESTED") return [];
  return [
    {
      key: "review-decision:CHANGES_REQUESTED",
      kind: "review",
      body: "Pull request review decision is CHANGES_REQUESTED.",
    },
  ];
}

function readCheckFeedback(pullRequest: Record<string, unknown>): PullRequestFeedback[] {
  const commits = readNodes(asRecord(pullRequest.commits)?.nodes);
  const commit = asRecord(asRecord(commits.at(-1))?.commit);
  const contexts = readNodes(asRecord(asRecord(commit?.statusCheckRollup)?.contexts)?.nodes);
  return contexts.flatMap((value) => {
    const context = asRecord(value);
    if (context === undefined) return [];
    const name = readString(context.name) ?? readString(context.context);
    const conclusion = readString(context.conclusion) ?? readString(context.state) ?? "unknown";
    if (name === undefined || isPassingOrPending(conclusion)) return [];
    const url = readString(context.detailsUrl) ?? readString(context.targetUrl);
    const completedAt = readString(context.completedAt);
    const startedAt = readString(context.startedAt) ?? readString(context.createdAt);
    return [
      {
        key: createCheckFeedbackKey({
          name,
          conclusion,
          ...(url === undefined ? {} : { url }),
          ...(completedAt === undefined ? {} : { completedAt }),
          ...(startedAt === undefined ? {} : { startedAt }),
        }),
        kind: "check" as const,
        body: `Check ${name} is ${conclusion}.`,
        ...(url === undefined ? {} : { url }),
        check: {
          id: readString(context.id) ?? name,
          name,
          conclusion,
          url: url ?? "",
          completedAt: completedAt ?? "",
          startedAt: startedAt ?? "",
        },
      },
    ];
  });
}

function isPassingOrPending(conclusion: string): boolean {
  return ["success", "skipped", "neutral", "pending", "queued", "in_progress"].includes(
    conclusion.toLowerCase(),
  );
}

function hasConductorMarker(body: string): boolean {
  return (
    body.toLowerCase().includes("<!-- pi-conductor -->") ||
    /^pi conductor (associated pr|stopped run|blocked run|completed run)/iu.test(body)
  );
}

function readNodes(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
