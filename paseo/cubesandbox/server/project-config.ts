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

export async function discoverGitProject(
  startPath: string,
): Promise<GitProjectMetadata> {
  const root = await git(startPath, ["rev-parse", "--show-toplevel"]);
  const remote = await git(root, ["remote", "get-url", "origin"]);
  const repository = repositoryFromRemote(remote);
  const repositoryName = repository.split("/").filter(Boolean).at(-1);
  if (!repositoryName)
    throw new Error(`Cannot derive repository name from origin: ${remote}`);

  let defaultRef: string;
  try {
    const symbolic = await git(root, [
      "symbolic-ref",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    defaultRef = symbolic.replace(/^origin\//, "");
  } catch {
    defaultRef = await git(root, ["branch", "--show-current"]);
  }
  if (!defaultRef) throw new Error("Cannot derive default Git ref");
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
  const cubeDirectory = path.join(metadata.root, ".cube");
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
