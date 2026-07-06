import { Type } from "typebox";
import { Value } from "typebox/value";

import { asRecord, readString } from "../utils/unknown-data.js";
import { parseJsonValue } from "./json.js";

const GhPrChecksSchema = Type.Array(
  Type.Object({
    name: Type.String(),
    state: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    conclusion: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    link: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    bucket: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    completedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    startedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }),
);

const GhPrViewFeedbackSchema = Type.Object({
  comments: Type.Optional(Type.Array(Type.Unknown())),
  reviews: Type.Optional(Type.Array(Type.Unknown())),
  reviewDecision: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const GhReviewCommentsSchema = Type.Array(Type.Unknown());

export type PullRequestFeedback = {
  key: string;
  kind: "check" | "comment" | "review" | "review_comment" | "issue_comment";
  body: string;
  url?: string;
  author?: string;
  check?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  review?: Record<string, unknown>;
  review_comment?: Record<string, unknown>;
  issue_comment?: Record<string, unknown>;
};

export function parseGhPrChecks(stdout: string): PullRequestFeedback[] {
  return Value.Parse(GhPrChecksSchema, parseJsonValue(stdout, "gh pr checks")).flatMap((check) => {
    const conclusion = check.conclusion ?? check.state ?? "unknown";
    if (isPendingCheck(check.bucket, conclusion)) return [];
    if (isPassingCheckConclusion(conclusion)) return [];
    const occurrence =
      check.link ?? check.completedAt ?? check.startedAt ?? check.bucket ?? "latest";
    return [
      {
        key: `check:${check.name}:${conclusion}:${occurrence}`,
        kind: "check" as const,
        body: `Check ${check.name} is ${conclusion}.`,
        check: {
          name: check.name,
          conclusion,
          link: check.link ?? "",
          bucket: check.bucket ?? "",
          completedAt: check.completedAt ?? "",
          startedAt: check.startedAt ?? "",
        },
        ...(check.link === undefined || check.link === null ? {} : { url: check.link }),
      },
    ];
  });
}

export function parseGhPrViewFeedback(stdout: string): PullRequestFeedback[] {
  const parsed = Value.Parse(GhPrViewFeedbackSchema, parseJsonValue(stdout, "gh pr view"));
  const comments = (parsed.comments ?? []).flatMap((comment) =>
    normalizeFeedbackNode(comment, "comment"),
  );
  const reviews = (parsed.reviews ?? []).flatMap((review) =>
    normalizeFeedbackNode(review, "review"),
  );
  const decisionFeedback =
    parsed.reviewDecision === "CHANGES_REQUESTED"
      ? [
          {
            key: "review-decision:CHANGES_REQUESTED",
            kind: "review" as const,
            body: "Pull request review decision is CHANGES_REQUESTED.",
          },
        ]
      : [];
  return [...comments, ...reviews, ...decisionFeedback];
}

export function parseGhReviewComments(stdout: string): PullRequestFeedback[] {
  return flattenGhApiPages(
    Value.Parse(GhReviewCommentsSchema, parseJsonValue(stdout, "gh pr review comments")),
  ).flatMap((comment) => normalizeFeedbackNode(comment, "review_comment"));
}

export function parseGhIssueComments(stdout: string): PullRequestFeedback[] {
  return flattenGhApiPages(
    Value.Parse(GhReviewCommentsSchema, parseJsonValue(stdout, "gh issue comments")),
  ).flatMap((comment) => normalizeFeedbackNode(comment, "issue_comment"));
}

function normalizeFeedbackNode(
  node: unknown,
  kind: PullRequestFeedback["kind"],
): PullRequestFeedback[] {
  const record = asRecord(node);
  const body = readString(record?.body);
  if (record === undefined || body === undefined || body.trim().length === 0) return [];
  const id =
    readString(record.id) ?? readString(record.databaseId) ?? readString(record.url) ?? body;
  const url = readString(record.url);
  const author =
    readString(asRecord(record.author)?.login) ?? readString(asRecord(record.user)?.login);
  return [
    {
      key: `${kind}:${id}`,
      kind,
      body,
      [kind]: {
        id,
        body,
        url: url ?? "",
        author: author ?? "",
      },
      ...(url === undefined ? {} : { url }),
      ...(author === undefined ? {} : { author }),
    },
  ];
}

function isPassingCheckConclusion(conclusion: string): boolean {
  const normalized = conclusion.toLowerCase();
  return normalized === "success" || normalized === "skipped" || normalized === "neutral";
}

function isPendingCheck(bucket: string | null | undefined, conclusion: string): boolean {
  return bucket?.toLowerCase() === "pending" || conclusion.toLowerCase() === "pending";
}

function flattenGhApiPages(nodes: unknown[]): unknown[] {
  return nodes.flatMap((node) => (Array.isArray(node) ? (node as unknown[]) : [node]));
}
