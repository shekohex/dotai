import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ReviewCheckoutTarget } from "./types.js";

export async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string | null> {
  try {
    const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
    if (upstream.code === 0 && upstream.stdout.trim()) {
      const mergeBase = await pi.exec("git", ["merge-base", "HEAD", upstream.stdout.trim()]);
      if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
        return mergeBase.stdout.trim();
      }
    }

    const mergeBase = await pi.exec("git", ["merge-base", "HEAD", branch]);
    if (mergeBase.code === 0 && mergeBase.stdout.trim()) {
      return mergeBase.stdout.trim();
    }

    return null;
  } catch {
    return null;
  }
}

export async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
  const result = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function getRecentCommits(
  pi: ExtensionAPI,
  limit = 20,
): Promise<Array<{ sha: string; title: string }>> {
  const result = await pi.exec("git", ["log", "--oneline", "-n", String(limit)]);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split(" ");
      return { sha, title: rest.join(" ") };
    });
}

export async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const result = await pi.exec("git", ["status", "--porcelain"]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

export async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
  const result = await pi.exec("git", ["status", "--porcelain"]);
  if (result.code !== 0) {
    return false;
  }

  return (
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length > 0
  );
}

export async function getPrInfo(
  pi: ExtensionAPI,
  prNumber: number,
  repo?: string,
): Promise<{ baseBranch: string; title: string; headBranch: string } | null> {
  const command = ["pr", "view", String(prNumber), "--json", "baseRefName,title,headRefName"];
  if (repo) {
    command.push("--repo", repo);
  }
  const result = await pi.exec("gh", command);
  if (result.code !== 0) {
    return null;
  }

  try {
    const data = JSON.parse(result.stdout) as {
      baseRefName?: string;
      title?: string;
      headRefName?: string;
    };
    if (!data.baseRefName || !data.title || !data.headRefName) {
      return null;
    }

    return {
      baseBranch: data.baseRefName,
      title: data.title,
      headBranch: data.headRefName,
    };
  } catch {
    return null;
  }
}

export async function checkoutPr(
  pi: ExtensionAPI,
  prNumber: number,
  repo?: string,
): Promise<{ success: boolean; error?: string }> {
  const command = ["pr", "checkout", String(prNumber)];
  if (repo) {
    command.push("--repo", repo);
  }
  const result = await pi.exec("gh", command);
  if (result.code !== 0) {
    return { success: false, error: result.stderr || result.stdout || "Failed to checkout PR" };
  }

  return { success: true };
}

export async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
  const result = await pi.exec("git", ["branch", "--show-current"]);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export async function getCurrentCheckoutTarget(
  pi: ExtensionAPI,
): Promise<ReviewCheckoutTarget | null> {
  const branchResult = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.code === 0 && branchResult.stdout.trim()) {
    return { type: "branch", name: branchResult.stdout.trim() };
  }

  const commitResult = await pi.exec("git", ["rev-parse", "--verify", "HEAD"]);
  if (commitResult.code === 0 && commitResult.stdout.trim()) {
    return { type: "detached", commit: commitResult.stdout.trim() };
  }

  return null;
}

export async function restoreCheckoutTarget(
  pi: ExtensionAPI,
  target: ReviewCheckoutTarget | undefined,
): Promise<{ success: boolean; error?: string }> {
  if (!target) {
    return { success: true };
  }

  const args =
    target.type === "branch" ? ["checkout", target.name] : ["checkout", "--detach", target.commit];
  const result = await pi.exec("git", args);
  if (result.code !== 0) {
    return {
      success: false,
      error: result.stderr || result.stdout || "Failed to restore original checkout",
    };
  }

  return { success: true };
}

export async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
  const remoteHead = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) {
    return remoteHead.stdout.trim().replace("origin/", "");
  }

  const branches = await getLocalBranches(pi);
  if (branches.includes("main")) {
    return "main";
  }
  if (branches.includes("master")) {
    return "master";
  }

  return "main";
}

export async function getTrackedPaths(pi: ExtensionAPI): Promise<string[]> {
  const result = await pi.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (result.code !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}
