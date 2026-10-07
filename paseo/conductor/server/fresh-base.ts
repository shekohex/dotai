import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Leaves room inside Paseo's 30s before-hook budget. */
const FETCH_TIMEOUT_MS = 15_000;

export interface WorktreeSourceInput {
  kind: "worktree";
  cwd?: string;
  action?: "branch-off" | "checkout";
  refName?: string;
  baseBranch?: string;
  checkoutSource?: unknown;
  githubPrNumber?: number;
}

export type FreshBaseResult =
  | { status: "skipped"; reason: string }
  | {
      status: "up-to-date" | "fast-forwarded";
      branch: string;
      checkout: string | null;
    }
  | { status: "ahead" | "diverged"; branch: string };

async function git(
  cwd: string,
  args: string[],
  timeout?: number,
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  return git(cwd, args).catch(() => null);
}

/** Mirrors Paseo's branch-off base resolution: refName, then baseBranch, then repo default. */
export function requestedBranchOffBase(
  source: WorktreeSourceInput,
): string | null | undefined {
  if (source.action === "checkout") return undefined;
  if (source.checkoutSource || source.githubPrNumber !== undefined)
    return undefined;
  return source.refName?.trim() || source.baseBranch?.trim() || null;
}

async function defaultBranch(cwd: string): Promise<string | null> {
  const remoteHead = await gitOrNull(cwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  return remoteHead?.replace(/^origin\//, "") ?? null;
}

async function checkoutOf(cwd: string, branch: string): Promise<string | null> {
  const porcelain = await git(cwd, ["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

/**
 * Fast-forwards the local base branch to its upstream before Paseo cuts a worktree from it.
 * Paseo resolves an unqualified base like `main` to the local branch without fetching, so
 * worktrees otherwise start from whatever was last pulled. Never rewrites diverged history.
 */
export async function fastForwardBaseBranch(
  cwd: string,
  requestedBase: string | null,
): Promise<FreshBaseResult> {
  const branch = requestedBase ?? (await defaultBranch(cwd));
  if (!branch)
    return {
      status: "skipped",
      reason: "no default branch (origin/HEAD unset)",
    };
  if (branch.startsWith("refs/") || branch.startsWith("origin/")) {
    return {
      status: "skipped",
      reason: `${branch} is a remote ref; Paseo refreshes it`,
    };
  }
  if (
    (await gitOrNull(cwd, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ])) === null
  ) {
    return { status: "skipped", reason: `no local branch ${branch}` };
  }
  const remote = await gitOrNull(cwd, ["config", `branch.${branch}.remote`]);
  const merge = await gitOrNull(cwd, ["config", `branch.${branch}.merge`]);
  if (!remote || remote === "." || !merge?.startsWith("refs/heads/")) {
    return { status: "skipped", reason: `${branch} has no remote upstream` };
  }

  const remoteBranch = merge.slice("refs/heads/".length);
  const upstreamRef = `refs/remotes/${remote}/${remoteBranch}`;
  await git(
    cwd,
    ["fetch", remote, `+${merge}:${upstreamRef}`],
    FETCH_TIMEOUT_MS,
  );

  const local = await git(cwd, ["rev-parse", `refs/heads/${branch}`]);
  const upstream = await git(cwd, ["rev-parse", upstreamRef]);
  const checkout = await checkoutOf(cwd, branch);
  if (local === upstream) return { status: "up-to-date", branch, checkout };
  if (
    (await gitOrNull(cwd, ["merge-base", "--is-ancestor", upstream, local])) !==
    null
  ) {
    return { status: "ahead", branch };
  }
  if (
    (await gitOrNull(cwd, ["merge-base", "--is-ancestor", local, upstream])) ===
    null
  ) {
    return { status: "diverged", branch };
  }

  if (checkout) {
    await git(checkout, ["merge", "--ff-only", upstreamRef]);
  } else {
    await git(cwd, ["update-ref", `refs/heads/${branch}`, upstream, local]);
  }
  return { status: "fast-forwarded", branch, checkout };
}
