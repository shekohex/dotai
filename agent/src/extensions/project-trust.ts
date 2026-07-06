import type { ExtensionAPI, ProjectTrustEventResult } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { asRecord, readString } from "../utils/unknown-data.js";

const trustedProjectRoots = ["/home/coder/project", "/home/coder/dotai"] as const;

function isPathInsideOrEqual(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

export function isDefaultTrustedProjectPath(path: string): boolean {
  return [...trustedProjectRoots, ...conductorWorktreeRoots()].some((root) =>
    isPathInsideOrEqual(path, root),
  );
}

function conductorWorktreeRoots(): string[] {
  const defaultRoot = getDefaultConductorRoot();
  const config = readConductorConfig(defaultRoot);
  return uniquePaths([
    join(defaultRoot, "worktrees"),
    ...(config.stateRoot === undefined ? [] : [join(expandHome(config.stateRoot), "worktrees")]),
    ...config.worktreeRoots.map(expandHome),
  ]);
}

function readConductorConfig(defaultRoot: string): { stateRoot?: string; worktreeRoots: string[] } {
  try {
    const config = asRecord(JSON.parse(readFileSync(join(defaultRoot, "config.json"), "utf8")));
    if (config === undefined) return { worktreeRoots: [] };
    return {
      ...(readString(config.stateRoot) === undefined
        ? {}
        : { stateRoot: readString(config.stateRoot) }),
      worktreeRoots: (Array.isArray(config.repositories) ? config.repositories : []).flatMap(
        (repo) => {
          const worktreeRoot = readString(asRecord(repo)?.worktreeRoot);
          return worktreeRoot === undefined ? [] : [worktreeRoot];
        },
      ),
    };
  } catch {
    return { worktreeRoots: [] };
  }
}

function getDefaultConductorRoot(): string {
  return join(getAgentDir(), "conductor");
}

function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured === undefined || configured.length === 0
    ? join(homedir(), ".pi", "agent")
    : expandHome(configured);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith(`~${sep}`) ? join(homedir(), path.slice(2)) : path;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

export default function projectTrustExtension(pi: ExtensionAPI) {
  pi.on("project_trust", (event): ProjectTrustEventResult => {
    if (isDefaultTrustedProjectPath(event.cwd)) {
      return { trusted: "yes", remember: true };
    }

    return { trusted: "undecided" };
  });
}
