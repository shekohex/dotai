import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fastForwardBaseBranch, requestedBranchOffBase } from "./fresh-base.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

async function commit(cwd: string, name: string): Promise<string> {
  await writeFile(path.join(cwd, name), name);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}

/** origin (bare), `source` (the user's stale checkout), and `other` (pushes new work). */
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-git-"));
  const origin = path.join(root, "origin.git");
  const source = path.join(root, "source");
  const other = path.join(root, "other");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, source);
  await commit(source, "a");
  git(source, "push", "-u", "origin", "main");
  git(source, "remote", "set-head", "origin", "main");
  git(root, "clone", origin, other);
  const latest = await commit(other, "b");
  git(other, "push", "origin", "main");
  return { source, other, latest };
}

describe("fastForwardBaseBranch", () => {
  it("fast-forwards the checked-out default branch, including its working tree", async () => {
    const { source, latest } = await setup();
    const result = await fastForwardBaseBranch(source, null);
    expect(result).toMatchObject({ status: "fast-forwarded", branch: "main" });
    expect(git(source, "rev-parse", "main")).toBe(latest);
    expect(git(source, "status", "--porcelain")).toBe("");
  });

  it("fast-forwards a base branch that is not checked out", async () => {
    const { source, latest } = await setup();
    git(source, "switch", "-c", "feature");
    const result = await fastForwardBaseBranch(source, "main");
    expect(result).toEqual({
      status: "fast-forwarded",
      branch: "main",
      checkout: null,
    });
    expect(git(source, "rev-parse", "main")).toBe(latest);
    expect(git(source, "branch", "--show-current")).toBe("feature");
  });

  it("never rewrites a diverged local branch", async () => {
    const { source } = await setup();
    const local = await commit(source, "local-only");
    expect(await fastForwardBaseBranch(source, "main")).toEqual({
      status: "diverged",
      branch: "main",
    });
    expect(git(source, "rev-parse", "main")).toBe(local);
  });

  it("reports up-to-date on second run and skips remote refs", async () => {
    const { source } = await setup();
    await fastForwardBaseBranch(source, "main");
    expect(await fastForwardBaseBranch(source, "main")).toMatchObject({
      status: "up-to-date",
    });
    expect(await fastForwardBaseBranch(source, "origin/main")).toMatchObject({
      status: "skipped",
    });
  });
});

describe("requestedBranchOffBase", () => {
  it("follows Paseo's precedence and ignores checkouts", () => {
    expect(
      requestedBranchOffBase({
        kind: "worktree",
        refName: "dev",
        baseBranch: "main",
      }),
    ).toBe("dev");
    expect(
      requestedBranchOffBase({ kind: "worktree", baseBranch: "main" }),
    ).toBe("main");
    expect(requestedBranchOffBase({ kind: "worktree" })).toBeNull();
    expect(
      requestedBranchOffBase({ kind: "worktree", action: "checkout" }),
    ).toBeUndefined();
    expect(
      requestedBranchOffBase({ kind: "worktree", githubPrNumber: 4 }),
    ).toBeUndefined();
  });
});
