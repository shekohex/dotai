import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { ResolvedRepositoryConfig } from "./config.js";
import { renderBranchTemplate, slugify } from "./run-id.js";
import type { WorkItem } from "./store/types.js";

const execFileAsync = promisify(execFile);

export type WorktreeExec = (
  file: string,
  args: string[],
  options: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export type WorktreePlan = {
  owner: string;
  repo: string;
  issueNumber: number;
  slug: string;
  branch: string;
  baseRef: string;
  worktreePath: string;
};

export class WorktreeManager {
  constructor(private readonly exec: WorktreeExec = defaultWorktreeExec) {}

  plan(config: ResolvedRepositoryConfig, workItem: WorkItem, defaultBranch: string): WorktreePlan {
    const slug = slugify(workItem.title);
    const branch = renderBranchTemplate(config.branchTemplate, {
      prefix: config.branchPrefix,
      kind: config.branchKind,
      issue: workItem.issueNumber,
      slug,
      repo: config.repo,
      owner: config.owner,
    });
    return {
      owner: config.owner,
      repo: config.repo,
      issueNumber: workItem.issueNumber,
      slug,
      branch,
      baseRef: config.baseRef ?? defaultBranch,
      worktreePath: join(config.worktreeRoot, String(workItem.issueNumber)),
    };
  }

  async prepare(config: ResolvedRepositoryConfig, plan: WorktreePlan): Promise<void> {
    await mkdir(dirname(plan.worktreePath), { recursive: true });
    await this.git(config.repoPath, ["fetch", "origin", plan.baseRef]);
    if (await this.pathExistsAsWorktree(config.repoPath, plan.worktreePath)) return;

    if (await this.branchExists(config.repoPath, plan.branch)) {
      await this.git(config.repoPath, ["worktree", "add", plan.worktreePath, plan.branch]);
      return;
    }

    await this.git(config.repoPath, [
      "worktree",
      "add",
      "-B",
      plan.branch,
      plan.worktreePath,
      `origin/${plan.baseRef}`,
    ]);
  }

  async cleanupLocal(
    config: ResolvedRepositoryConfig,
    plan: Pick<WorktreePlan, "worktreePath" | "branch">,
    options: { allowDirty?: boolean } = {},
  ): Promise<void> {
    this.assertOwnedWorktree(config, plan.worktreePath);
    if (options.allowDirty !== true && (await pathExists(plan.worktreePath))) {
      await this.preserveDirtyWorktree(plan.worktreePath, plan.branch);
    }
    await this.removeWorktree(config.repoPath, plan.worktreePath);
    await this.deleteLocalBranch(config.repoPath, plan.branch);
  }

  async cleanupMerged(
    config: ResolvedRepositoryConfig,
    plan: Pick<WorktreePlan, "worktreePath" | "branch">,
  ): Promise<void> {
    await this.cleanupLocal(config, plan, { allowDirty: true });
    await this.deleteRemoteBranch(config.repoPath, plan.branch);
  }

  private async preserveDirtyWorktree(worktreePath: string, branch: string): Promise<void> {
    const status = await this.git(worktreePath, ["status", "--porcelain"]);
    if (status.stdout.trim().length === 0) return;
    await this.git(worktreePath, [
      "stash",
      "push",
      "--include-untracked",
      "--message",
      `pi-conductor preserved ${branch} before cleanup`,
    ]);
  }

  private async pathExistsAsWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
    const result = await this.git(repoPath, ["worktree", "list", "--porcelain"]);
    return result.stdout.split("\n").some((line) => line === `worktree ${worktreePath}`);
  }

  private async branchExists(repoPath: string, branch: string): Promise<boolean> {
    try {
      await this.git(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      await this.git(repoPath, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
    }
  }

  private async deleteLocalBranch(repoPath: string, branch: string): Promise<void> {
    if (!(await this.branchExists(repoPath, branch))) return;
    await this.git(repoPath, ["branch", "-D", branch]);
  }

  private async deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
    const remote = await this.git(repoPath, ["ls-remote", "--heads", "origin", branch]);
    if (remote.stdout.trim().length === 0) return;
    await this.git(repoPath, ["push", "origin", "--delete", branch]);
  }

  private git(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.exec("git", ["-C", repoPath, ...args], { cwd: repoPath });
  }

  private assertOwnedWorktree(config: ResolvedRepositoryConfig, worktreePath: string): void {
    const root = resolve(config.worktreeRoot);
    const target = resolve(worktreePath);
    const relativePath = relative(root, target);
    if (relativePath.startsWith("..") || relativePath === "") {
      throw new Error(`Refusing to clean worktree outside conductor root: ${worktreePath}`);
    }
  }
}

export function relativePromptPath(): string {
  return join(".pi", "conductor", "run", "initial-prompt.md");
}

async function defaultWorktreeExec(
  file: string,
  args: string[],
  options: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
