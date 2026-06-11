import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ParsedRepository = {
  host: string;
  segments: string[];
  cloneUrl: string;
};

export type RepositoryCheckoutResult =
  | { ok: true; path: string }
  | { ok: false; path: string; error: string };

const CACHE_ROOT = path.join(os.homedir(), ".cache", "checkouts");

function stripGitSuffix(input: string): string {
  return input.endsWith(".git") ? input.slice(0, -4) : input;
}

function normalizeInput(input: string): string {
  return input
    .trim()
    .replace(/^git\+/, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
}

function pathParts(input: string): string[] {
  return input
    .split("/")
    .map((item) => stripGitSuffix(item.trim()))
    .filter(Boolean);
}

function safeHost(input: string): boolean {
  return input.length > 0 && !input.startsWith("-") && !/[\s/\\]/.test(input);
}

function safeSegment(input: string): boolean {
  return input !== "." && input !== ".." && !input.includes(":") && !/[\s/\\]/.test(input);
}

function hostLike(input: string): boolean {
  return input.includes(".") || input.includes(":") || input === "localhost";
}

function githubCloneUrl(repositoryPath: string): string {
  return `https://github.com/${repositoryPath}.git`;
}

function buildRemote(input: {
  host: string;
  segments: string[];
  cloneUrl?: string;
}): ParsedRepository | null {
  const segments = input.segments.map(stripGitSuffix).filter(Boolean);
  if (
    !safeHost(input.host) ||
    segments.length === 0 ||
    segments.some((segment) => !safeSegment(segment))
  ) {
    return null;
  }
  const host = input.host.toLowerCase();
  const repositoryPath = segments.join("/");
  return {
    host,
    segments,
    cloneUrl:
      input.cloneUrl ??
      (host === "github.com"
        ? githubCloneUrl(repositoryPath)
        : `https://${host}/${repositoryPath}.git`),
  };
}

export function parseRepositoryReference(input: string): ParsedRepository | null {
  const trimmed = normalizeInput(input);
  if (trimmed.length === 0) {
    return null;
  }

  const githubPrefixed = trimmed.match(/^github:([^/\s]+)\/([^/\s]+)$/);
  if (githubPrefixed) {
    return buildRemote({ host: "github.com", segments: [githubPrefixed[1], githubPrefixed[2]] });
  }

  if (!trimmed.includes("://")) {
    const scp = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) {
      return buildRemote({ host: scp[1], segments: pathParts(scp[2]), cloneUrl: trimmed });
    }

    const direct = pathParts(trimmed);
    if (direct.length >= 2 && hostLike(direct[0])) {
      return buildRemote({ host: direct[0], segments: direct.slice(1) });
    }
    if (direct.length === 2) {
      return buildRemote({ host: "github.com", segments: direct });
    }
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ssh:") {
      return buildRemote({ host: url.host, segments: pathParts(url.pathname), cloneUrl: trimmed });
    }
  } catch {
    return null;
  }

  return null;
}

export function validateRepositoryBranch(branch: string): string | undefined {
  if (/^[A-Za-z0-9/_.-]+$/.test(branch) && !branch.startsWith("-") && !branch.includes("..")) {
    return undefined;
  }
  return "Branch must contain only alphanumeric characters, /, _, ., and -, and cannot start with - or contain ..";
}

export function getRepositoryCachePath(repository: ParsedRepository): string {
  return path.join(CACHE_ROOT, repository.host, ...repository.segments);
}

function execOutput(result: { stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim();
}

function normalizeBranch(branch: string | undefined): string | undefined {
  if (branch === undefined || branch.length === 0) {
    return undefined;
  }
  return branch;
}

function remoteBranchName(remoteRef: string): string | undefined {
  if (remoteRef === "origin/HEAD" || !remoteRef.startsWith("origin/")) {
    return undefined;
  }
  return remoteRef.slice("origin/".length);
}

function safeRemoteBranch(branch: string | undefined): string | undefined {
  if (branch === undefined || validateRepositoryBranch(branch) !== undefined) {
    return undefined;
  }
  return branch;
}

function parseRemoteHeadBranch(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = line.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/);
    if (match) {
      return safeRemoteBranch(match[1]);
    }
  }
  return undefined;
}

async function currentRemoteBranch(
  pi: Pick<ExtensionAPI, "exec">,
  checkoutPath: string,
): Promise<string | undefined> {
  const upstream = await pi.exec(
    "git",
    ["-C", checkoutPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { timeout: 5_000 },
  );
  const upstreamBranch = safeRemoteBranch(remoteBranchName(upstream.stdout.trim()));
  if (upstream.code === 0 && upstreamBranch !== undefined) {
    return upstreamBranch;
  }

  const originHead = await pi.exec(
    "git",
    ["-C", checkoutPath, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { timeout: 5_000 },
  );
  const originHeadBranch = safeRemoteBranch(remoteBranchName(originHead.stdout.trim()));
  if (originHead.code === 0 && originHeadBranch !== undefined) {
    return originHeadBranch;
  }

  const remoteHead = await pi.exec(
    "git",
    ["-C", checkoutPath, "ls-remote", "--symref", "origin", "HEAD"],
    {
      timeout: 30_000,
    },
  );
  if (remoteHead.code === 0) {
    return parseRemoteHeadBranch(remoteHead.stdout);
  }

  return undefined;
}

async function ensureCleanWorktree(
  pi: Pick<ExtensionAPI, "exec">,
  checkoutPath: string,
): Promise<string | undefined> {
  const status = await pi.exec("git", ["-C", checkoutPath, "status", "--porcelain"], {
    timeout: 5_000,
  });
  if (status.code !== 0) {
    return execOutput(status);
  }
  if (status.stdout.trim().length > 0) {
    return "cached checkout has local changes";
  }
  return undefined;
}

async function configurePartialClone(
  pi: Pick<ExtensionAPI, "exec">,
  checkoutPath: string,
): Promise<void> {
  await pi.exec("git", ["-C", checkoutPath, "config", "remote.origin.promisor", "true"], {
    timeout: 5_000,
  });
  await pi.exec(
    "git",
    ["-C", checkoutPath, "config", "remote.origin.partialclonefilter", "blob:none"],
    { timeout: 5_000 },
  );
}

async function cleanupRepositoryCheckout(
  pi: Pick<ExtensionAPI, "exec">,
  checkoutPath: string,
): Promise<void> {
  await pi.exec(
    "git",
    ["-C", checkoutPath, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"],
    { timeout: 30_000 },
  );
  await pi.exec("git", ["-C", checkoutPath, "gc", "--prune=now"], { timeout: 60_000 });
}

async function resetCheckoutToRemote(
  pi: Pick<ExtensionAPI, "exec">,
  checkoutPath: string,
  remoteBranch: string | undefined,
): Promise<string | undefined> {
  const dirtyError = await ensureCleanWorktree(pi, checkoutPath);
  if (dirtyError !== undefined) {
    return dirtyError;
  }

  if (remoteBranch !== undefined) {
    const checkout = await pi.exec(
      "git",
      ["-C", checkoutPath, "checkout", "-B", remoteBranch, `origin/${remoteBranch}`],
      { timeout: 30_000 },
    );
    if (checkout.code !== 0) {
      return execOutput(checkout);
    }
    return undefined;
  }

  const reset = await pi.exec("git", ["-C", checkoutPath, "reset", "--hard", "origin/HEAD"], {
    timeout: 30_000,
  });
  return reset.code === 0 ? undefined : execOutput(reset);
}

export async function ensureRepositoryCheckout(
  pi: Pick<ExtensionAPI, "exec">,
  repositoryInput: string,
  branch?: string,
): Promise<RepositoryCheckoutResult> {
  const repository = parseRepositoryReference(repositoryInput);
  if (repository === null) {
    return { ok: false, path: "", error: `invalid repository reference: ${repositoryInput}` };
  }

  const normalizedBranch = normalizeBranch(branch);
  if (normalizedBranch !== undefined) {
    const branchError = validateRepositoryBranch(normalizedBranch);
    if (branchError !== undefined) {
      return { ok: false, path: "", error: branchError };
    }
  }

  const checkoutPath = getRepositoryCachePath(repository);
  const exists = await pi.exec("git", ["-C", checkoutPath, "rev-parse", "--git-dir"], {
    timeout: 5_000,
  });

  if (exists.code !== 0) {
    await mkdir(path.dirname(checkoutPath), { recursive: true });
    const cloneArgs = ["clone", "--filter=blob:none", "--depth=1", "--single-branch", "--no-tags"];
    if (normalizedBranch !== undefined) {
      cloneArgs.push("--branch", normalizedBranch);
    }
    cloneArgs.push(repository.cloneUrl, checkoutPath);
    const clone = await pi.exec("git", cloneArgs, { timeout: 120_000 });
    if (clone.code !== 0) {
      return { ok: false, path: checkoutPath, error: execOutput(clone) };
    }
    await cleanupRepositoryCheckout(pi, checkoutPath);
    return { ok: true, path: checkoutPath };
  }

  await configurePartialClone(pi, checkoutPath);
  const remoteBranch = normalizedBranch ?? (await currentRemoteBranch(pi, checkoutPath));
  const fetchArgs = [
    "-C",
    checkoutPath,
    "fetch",
    "--depth=1",
    "--filter=blob:none",
    "--prune",
    "--force",
    "--no-tags",
    "origin",
  ];
  if (remoteBranch !== undefined) {
    fetchArgs.push(`+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`);
  }

  const fetch = await pi.exec("git", fetchArgs, { timeout: 60_000 });
  if (fetch.code !== 0) {
    return { ok: false, path: checkoutPath, error: execOutput(fetch) };
  }

  const resetError = await resetCheckoutToRemote(pi, checkoutPath, remoteBranch);
  if (resetError !== undefined) {
    return { ok: false, path: checkoutPath, error: resetError };
  }
  await cleanupRepositoryCheckout(pi, checkoutPath);
  return { ok: true, path: checkoutPath };
}
