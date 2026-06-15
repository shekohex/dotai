import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ThemeColor } from "../../mode-definitions.js";

const GITHUB_PULL_REQUEST_TIMEOUT_MS = 1_200;

const GitHubPullRequestStateSchema = Type.Union([
  Type.Literal("OPEN"),
  Type.Literal("CLOSED"),
  Type.Literal("MERGED"),
]);

const GitHubPullRequestCliSchema = Type.Object({
  number: Type.Number(),
  state: GitHubPullRequestStateSchema,
  isDraft: Type.Boolean(),
  url: Type.String(),
});

export const GitHubPullRequestInfoSchema = Type.Object({
  number: Type.Number(),
  state: GitHubPullRequestStateSchema,
  isDraft: Type.Boolean(),
  url: Type.String(),
});

export type GitHubPullRequestInfo = Static<typeof GitHubPullRequestInfoSchema>;

export function parseGitHubPullRequestInfo(stdout: string): GitHubPullRequestInfo | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  if (!Value.Check(GitHubPullRequestCliSchema, parsed)) {
    return undefined;
  }

  const pullRequest = Value.Parse(GitHubPullRequestCliSchema, parsed);
  if (pullRequest.number < 1 || pullRequest.url.trim().length === 0) {
    return undefined;
  }

  return pullRequest;
}

export async function loadGitHubPullRequestInfo(
  pi: ExtensionAPI,
  input: { gitRoot: string; signal?: AbortSignal },
): Promise<GitHubPullRequestInfo | undefined> {
  let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
  try {
    result = await pi.exec("gh", ["pr", "view", "--json", "number,state,isDraft,url"], {
      cwd: input.gitRoot,
      signal: input.signal,
      timeout: GITHUB_PULL_REQUEST_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }

  if (result.code !== 0) {
    return undefined;
  }

  return parseGitHubPullRequestInfo(result.stdout);
}

export function githubPullRequestColor(pullRequest: GitHubPullRequestInfo): ThemeColor {
  if (pullRequest.isDraft) {
    return "muted";
  }

  switch (pullRequest.state) {
    case "OPEN":
      return "success";
    case "CLOSED":
      return "error";
    case "MERGED":
      return "accent";
    default:
      return "muted";
  }
}
