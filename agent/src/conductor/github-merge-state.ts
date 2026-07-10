import { Type } from "typebox";
import { Value } from "typebox/value";

import { asRecord, readNumber, readString } from "../utils/unknown-data.js";
import type { PullRequestSummary } from "./github-types.js";
import { parseJsonValue } from "./json.js";

const GraphqlResponseSchema = Type.Object({ data: Type.Record(Type.String(), Type.Unknown()) });
const MERGE_STATE_FIELDS = `
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
`;

export function pullRequestMergeStateQuery(selector: "branch" | "number"): string {
  const selection =
    selector === "number"
      ? `pullRequest(number: $prNumber) { ${MERGE_STATE_FIELDS} }`
      : `pullRequests(first: 100, headRefName: $branch, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ${MERGE_STATE_FIELDS} }
        }`;
  const selectorVariable = selector === "number" ? "$prNumber: Int!" : "$branch: String!";
  return `
query($owner: String!, $repo: String!, ${selectorVariable}) {
  repository(owner: $owner, name: $repo) { ${selection} }
  rateLimit { cost limit remaining resetAt used }
}`;
}

export function parsePullRequestMergeStateGraphql(stdout: string): PullRequestSummary | undefined {
  const response = Value.Parse(
    GraphqlResponseSchema,
    parseJsonValue(stdout, "gh pull request merge state graphql"),
  );
  const repository = asRecord(response.data.repository);
  if (repository === undefined) return undefined;
  const pullRequest = selectPullRequest(repository);
  if (pullRequest === undefined) return undefined;
  return normalizePullRequest(pullRequest);
}

export function isMergeabilityPending(pr: PullRequestSummary | undefined): boolean {
  if (pr === undefined) return false;
  if (pr.mergedAt !== undefined || pr.state.toUpperCase() !== "OPEN") return false;
  const mergeable = pr.mergeable?.toUpperCase();
  const mergeStateStatus = pr.mergeStateStatus?.toUpperCase();
  return (
    (mergeable === undefined || mergeable === "UNKNOWN") &&
    (mergeStateStatus === undefined || mergeStateStatus === "UNKNOWN")
  );
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
    candidates.find((node) => readString(node.state)?.toUpperCase() === "OPEN") ?? candidates[0]
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
  return {
    number,
    url,
    headRefName,
    state,
    isDraft: node.isDraft === true,
    ...optionalString(node, "headRefOid"),
    ...optionalString(node, "baseRefName"),
    ...optionalString(node, "baseRefOid"),
    ...optionalString(node, "mergedAt"),
    ...optionalString(node, "mergeable"),
    ...optionalString(node, "mergeStateStatus"),
  };
}

function optionalString(
  value: Record<string, unknown>,
  key: "baseRefName" | "baseRefOid" | "headRefOid" | "mergedAt" | "mergeable" | "mergeStateStatus",
): Record<string, string> {
  const resolved = readString(value[key]);
  return resolved === undefined ? {} : { [key]: resolved };
}

function readNodes(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
