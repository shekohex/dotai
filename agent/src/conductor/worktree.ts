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
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
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
      await this.runHookPhase("postCreate", config, plan, plan.worktreePath);
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
    await this.runHookPhase("postCreate", config, plan, plan.worktreePath);
  }

  async cleanupLocal(
    config: ResolvedRepositoryConfig,
    plan: Pick<WorktreePlan, "worktreePath" | "branch">,
    options: { allowDirty?: boolean } = {},
  ): Promise<void> {
    this.assertOwnedWorktree(config, plan.worktreePath);
    const worktreePathExists = await pathExists(plan.worktreePath);
    const registeredWorktree =
      worktreePathExists && (await this.pathExistsAsWorktree(config.repoPath, plan.worktreePath));
    if (options.allowDirty !== true && registeredWorktree) {
      await this.preserveDirtyWorktree(plan.worktreePath, plan.branch);
    }
    if (registeredWorktree) {
      await this.runHookPhase("preRemove", config, plan, plan.worktreePath);
    }
    await this.removeWorktree(config.repoPath, plan.worktreePath);
    await this.deleteLocalBranch(config.repoPath, plan.branch);
    await this.runPostRemoveHooks(config, plan);
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

  private async runPostRemoveHooks(
    config: ResolvedRepositoryConfig,
    plan: Pick<WorktreePlan, "worktreePath" | "branch">,
  ): Promise<void> {
    try {
      await this.runHookPhase("postRemove", config, plan, config.repoPath);
    } catch {}
  }

  private async runHookPhase(
    phase: "postCreate" | "preRemove" | "postRemove",
    config: ResolvedRepositoryConfig,
    plan: Pick<WorktreePlan, "worktreePath" | "branch"> &
      Partial<Pick<WorktreePlan, "issueNumber">>,
    cwd: string,
  ): Promise<void> {
    const hooks = [
      ...(config.worktreeHooks[phase] ?? []),
      ...(await this.readLocalHooks(config.repoPath, phase)),
    ];
    for (const hook of hooks) {
      if (hook.trim().length === 0) continue;
      await this.exec(hookShell(), hookShellArgs(hook), {
        cwd,
        env: {
          ...process.env,
          REPO_ROOT: config.repoPath,
          WORKTREE_PATH: plan.worktreePath,
          BRANCH: plan.branch,
          PI_CONDUCTOR_OWNER: config.owner,
          PI_CONDUCTOR_REPO: config.repo,
          PI_CONDUCTOR_ISSUE_NUMBER: plan.issueNumber === undefined ? "" : String(plan.issueNumber),
        },
      });
    }
  }

  private async readLocalHooks(
    repoPath: string,
    phase: "postCreate" | "preRemove" | "postRemove",
  ): Promise<string[]> {
    try {
      const result = await this.git(repoPath, [
        "config",
        "--local",
        "--get-all",
        `pi.conductor.hook.${phase}`,
      ]);
      return result.stdout.split("\n").filter((line) => line.trim().length > 0);
    } catch {
      return [];
    }
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function hookShell(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return "/bin/sh";
}

function hookShellArgs(command: string): string[] {
  return process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
