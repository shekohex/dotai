import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  CUBE_CONFIG_SCHEMA_URL,
  cubeProjectConfigSchema,
  type CubeProjectConfig,
} from "../shared/config.js";

const executeFile = promisify(execFile);

export interface GitProjectMetadata {
  root: string;
  repository: string;
  repositoryName: string;
  defaultRef: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await executeFile("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return stdout.trim();
}

function isNotGitRepository(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("stderr" in error)) return false;
  const stderr = error.stderr;
  return (
    typeof stderr === "string" &&
    stderr.toLowerCase().includes("not a git repository")
  );
}

export async function findGitRoot(startPath: string): Promise<string | null> {
  try {
    return await git(startPath, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (isNotGitRepository(error)) return null;
    throw error;
  }
}

export function repositoryFromRemote(remote: string): string {
  const trimmed = remote
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const scpMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  if (scpMatch?.[1]) return scpMatch[1];
  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.replace(/^\//, "");
  } catch {
    return trimmed;
  }
}

async function validateDefaultRef(
  root: string,
  candidate: string,
): Promise<string> {
  if (!candidate) throw new Error("Git default branch is empty");
  await git(root, ["check-ref-format", "--branch", candidate]);
  return candidate;
}

async function resolveDefaultRef(root: string): Promise<string> {
  try {
    const symbolic = await git(root, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (!symbolic.startsWith("origin/")) {
      throw new Error("origin/HEAD does not target origin");
    }
    return await validateDefaultRef(root, symbolic.slice("origin/".length));
  } catch {
    try {
      const remoteHead = await git(root, [
        "ls-remote",
        "--symref",
        "origin",
        "HEAD",
      ]);
      const symbolicLine = remoteHead
        .split("\n")
        .find((line) => line.startsWith("ref: "));
      const match = symbolicLine?.match(/^ref: refs\/heads\/([^\t]+)\tHEAD$/);
      if (!match?.[1])
        throw new Error("origin did not advertise symbolic HEAD");
      return await validateDefaultRef(root, match[1]);
    } catch {
      throw new Error(
        "Cannot determine origin default branch. Ensure origin advertises symbolic HEAD or run `git remote set-head origin --auto`.",
      );
    }
  }
}

export async function discoverGitProject(
  startPath: string,
): Promise<GitProjectMetadata> {
  const root = await findGitRoot(startPath);
  if (!root) throw new Error(`Not a Git repository: ${startPath}`);
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const repository = repositoryFromRemote(remote);
  const repositoryName = repository.split("/").filter(Boolean).at(-1);
  if (!repositoryName)
    throw new Error(`Cannot derive repository name from origin: ${remote}`);

  const defaultRef = await resolveDefaultRef(root);
  return { root, repository, repositoryName, defaultRef };
}

export function createDefaultProjectConfig(
  metadata: GitProjectMetadata,
): CubeProjectConfig {
  return cubeProjectConfigSchema.parse({
    $schema: CUBE_CONFIG_SCHEMA_URL,
    version: 1,
    project: {
      id: metadata.repositoryName,
      repository: metadata.repository,
      defaultRef: metadata.defaultRef,
      workspacePath: `/workspace/${metadata.repositoryName}`,
    },
    cube: {
      apiUrl: "https://sandbox.0iq.xyz",
      sandboxDomain: "sbx.0iq.xyz",
    },
    template: {
      alias: metadata.repositoryName,
      dockerfile: ".cube/Dockerfile",
      buildContext: ".",
      resources: {
        cpuMillicores: 2000,
        memoryMb: 4096,
        writableLayerSize: "20G",
      },
    },
    sandbox: {
      idleTimeoutSeconds: 300,
      onTimeout: "pause",
      previewPorts: [],
    },
    snapshot: { mode: "manual" },
  });
}

export async function initializeProjectConfig(
  startPath: string,
): Promise<string> {
  const metadata = await discoverGitProject(startPath);
  return writeProjectConfig(metadata.root, metadata);
}

/**
 * Creates config at exactly one registered Paseo project root. Git metadata is
 * still derived from the repository, but the config directory never escapes the
 * provided root (for example a worktree or a nested registered project).
 */
export async function initializeProjectConfigAtProjectRoot(
  projectRoot: string,
): Promise<string> {
  const metadata = await discoverGitProject(projectRoot);
  return writeProjectConfig(projectRoot, { ...metadata, root: projectRoot });
}

async function writeProjectConfig(
  projectRoot: string,
  metadata: GitProjectMetadata,
): Promise<string> {
  const cubeDirectory = path.join(projectRoot, ".cube");
  const configPath = path.join(cubeDirectory, "config.json");
  try {
    await access(configPath, constants.F_OK);
    throw new Error(`Refusing to overwrite existing ${configPath}`);
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
  await mkdir(cubeDirectory, { recursive: true });
  const config = createDefaultProjectConfig(metadata);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return configPath;
}

export async function loadProjectConfig(
  repositoryRoot: string,
): Promise<CubeProjectConfig> {
  const configPath = path.join(repositoryRoot, ".cube", "config.json");
  const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
  return cubeProjectConfigSchema.parse(parsed);
}
