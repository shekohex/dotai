import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  collectSimplifyChangeContext,
  collectSimplifyDiff,
} from "../../src/extensions/dynamic-workflows/simplify.js";

const execFile = promisify(execFileCallback);

test("collectSimplifyDiff uses unstaged diff when no staged changes exist", async () => {
  const cwd = await createGitRepo();
  await writeFile(join(cwd, "demo.txt"), "changed\n");

  const diff = await collectSimplifyDiff(cwd);

  assert.match(diff, /-base/);
  assert.match(diff, /\+changed/);
});

test("collectSimplifyDiff uses HEAD diff when staged changes exist", async () => {
  const cwd = await createGitRepo();
  await writeFile(join(cwd, "demo.txt"), "staged\n");
  await execFile("git", ["add", "demo.txt"], { cwd });
  await writeFile(join(cwd, "demo.txt"), "unstaged\n");

  const diff = await collectSimplifyDiff(cwd);

  assert.match(diff, /-base/);
  assert.match(diff, /\+unstaged/);
});

test("collectSimplifyChangeContext reports exact diff command and lightweight context", async () => {
  const cwd = await createGitRepo();
  await writeFile(join(cwd, "demo.txt"), "changed\n");

  const context = await collectSimplifyChangeContext(cwd);

  assert.equal(context.diffCommand, "git diff");
  assert.match(context.status, / M demo\.txt/);
  assert.match(context.stat, /demo\.txt/);
});

async function createGitRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "simplify-diff-"));
  await execFile("git", ["init", "-b", "main"], { cwd });
  await execFile("git", ["config", "user.name", "Test User"], { cwd });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
  await writeFile(join(cwd, "demo.txt"), "base\n");
  await execFile("git", ["add", "demo.txt"], { cwd });
  await execFile("git", ["commit", "-m", "base"], { cwd });
  return cwd;
}
