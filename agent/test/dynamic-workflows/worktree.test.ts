import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createWorktree, removeWorktree } from "../../src/extensions/dynamic-workflows/worktree.js";

test("createWorktree no-ops (not isolated) outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-nogit-"));
  try {
    const wt = await createWorktree(dir, "run-1-0-task");
    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.match(wt.reason ?? "", /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorktree isolates in a git repo, then removeWorktree cleans up", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktree(repo, "run-9-0-edit");
    assert.equal(wt.isolated, true);
    assert.ok(wt.cwd !== repo && existsSync(wt.cwd), "worktree dir exists");
    assert.ok(existsSync(join(wt.cwd, "file.txt")), "worktree has a checkout");

    // Editing inside the worktree must not touch the base tree.
    writeFileSync(join(wt.cwd, "file.txt"), "changed in worktree\n");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

    await removeWorktree(wt);
    assert.ok(!existsSync(wt.cwd), "worktree dir removed");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], {
      encoding: "utf8",
    });
    assert.equal(branches.trim(), "", "branch deleted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
