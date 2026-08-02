import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HonchoSessionStrategy } from "./config.js";

const HASH_LENGTH = 12;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeRemote(remote: string): string | undefined {
  const scpMatch = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
  if (scpMatch !== null) {
    return `${scpMatch[1]}/${scpMatch[2]}`;
  }
  try {
    const url = new URL(remote);
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return path.length === 0 ? undefined : `${url.hostname}/${path}`;
  } catch {
    return undefined;
  }
}

async function gitOutput(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: 3_000 });
    const output = result.stdout.trim();
    return result.code === 0 && output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

async function repositoryKey(pi: Pick<ExtensionAPI, "exec">, cwd: string): Promise<string> {
  const remote = await gitOutput(pi, cwd, ["remote", "get-url", "origin"]);
  const normalizedRemote = remote === undefined ? undefined : normalizeRemote(remote);
  if (normalizedRemote !== undefined) return sanitize(`repo_${normalizedRemote}`);

  const root = await gitOutput(pi, cwd, ["rev-parse", "--show-toplevel"]);
  if (root !== undefined) {
    const name = root.split(/[\\/]/).at(-1) ?? "repo";
    return sanitize(`local_${name}_${shortHash(root)}`);
  }

  const name = cwd.split(/[\\/]/).at(-1) ?? "project";
  return sanitize(`cwd_${name}_${shortHash(cwd)}`);
}

async function branchKey(pi: Pick<ExtensionAPI, "exec">, cwd: string): Promise<string | undefined> {
  const branch = await gitOutput(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== undefined && branch !== "HEAD") return sanitize(branch);
  const commit = await gitOutput(pi, cwd, ["rev-parse", "--short", "HEAD"]);
  return commit === undefined ? undefined : sanitize(`detached_${commit}`);
}

export async function deriveHonchoSessionKey(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  strategy: HonchoSessionStrategy,
): Promise<string> {
  if (strategy === "directory") {
    const name = cwd.split(/[\\/]/).at(-1) ?? "project";
    return sanitize(`cwd_${name}_${shortHash(cwd)}`);
  }

  const projectKey = await repositoryKey(pi, cwd);
  if (strategy !== "git-branch") return projectKey;
  const branch = await branchKey(pi, cwd);
  return branch === undefined ? projectKey : `${projectKey}__branch_${branch}`;
}
