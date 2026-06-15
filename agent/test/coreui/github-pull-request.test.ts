import { describe, expect, test } from "vitest";
import {
  githubPullRequestColor,
  parseGitHubPullRequestInfo,
} from "../../src/extensions/coreui/github-pull-request.js";

describe("github pull request", () => {
  test("parses gh pr view output", () => {
    expect(
      parseGitHubPullRequestInfo(
        JSON.stringify({
          number: 12,
          state: "MERGED",
          isDraft: false,
          url: "https://github.com/shekohex/dotai/pull/12",
        }),
      ),
    ).toEqual({
      number: 12,
      state: "MERGED",
      isDraft: false,
      url: "https://github.com/shekohex/dotai/pull/12",
    });
  });

  test("ignores invalid gh output", () => {
    expect(parseGitHubPullRequestInfo("not json")).toBeUndefined();
    expect(parseGitHubPullRequestInfo(JSON.stringify({ number: 0 }))).toBeUndefined();
  });

  test("maps pr statuses to existing theme colors", () => {
    const base = { number: 1, url: "https://github.com/o/r/pull/1" } as const;

    expect(githubPullRequestColor({ ...base, state: "OPEN", isDraft: true })).toBe("muted");
    expect(githubPullRequestColor({ ...base, state: "OPEN", isDraft: false })).toBe("success");
    expect(githubPullRequestColor({ ...base, state: "CLOSED", isDraft: false })).toBe("error");
    expect(githubPullRequestColor({ ...base, state: "MERGED", isDraft: false })).toBe("accent");
  });
});
