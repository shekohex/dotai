import type { PaseoApi, PaseoProject } from "@getpaseo/client";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Synthetic project id used to surface records that cannot be mapped to a live project. */
export const UNASSIGNED_PROJECT_ID = "cubesandbox:unassigned";
/** Prefix for migrated records whose original project mapping was ambiguous or removed. */
export const LEGACY_PROJECT_PREFIX = "legacy:";

export type ProjectAvailability = "online" | "offline" | "removed";

export interface ProjectScope {
  projectId: string;
  displayName: string;
  declaredRoot: string;
  canonicalRoot: string;
  availability: ProjectAvailability;
  error?: string;
}

function preferredDisplayName(project: PaseoProject): string {
  const custom = project.projectCustomName?.trim();
  if (custom) return custom;
  const display = project.projectDisplayName.trim();
  if (display) return display;
  return project.projectId;
}

/**
 * Resolves a path to a canonical existing directory. Returns null when the path
 * is missing, unresolvable, or not a directory so callers can mark the scope
 * offline instead of mutating an unknown filesystem location.
 */
export async function canonicalizeExistingDirectory(
  target: string,
): Promise<string | null> {
  try {
    const resolved = await realpath(target);
    const info = await stat(resolved);
    return info.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** Canonicalizes a root, falling back to an absolute path when it no longer exists. */
export async function canonicalizeRoot(target: string): Promise<string> {
  return (await canonicalizeExistingDirectory(target)) ?? path.resolve(target);
}

function markRootCollisions(scopes: ProjectScope[]): void {
  const byRoot = new Map<string, ProjectScope[]>();
  for (const scope of scopes) {
    if (scope.availability !== "online") continue;
    const group = byRoot.get(scope.canonicalRoot) ?? [];
    group.push(scope);
    byRoot.set(scope.canonicalRoot, group);
  }
  for (const group of byRoot.values()) {
    if (group.length < 2) continue;
    for (const scope of group) {
      scope.availability = "offline";
      scope.error =
        "Project roots resolve to the same directory; this scope is ambiguous";
    }
  }
}

/**
 * Authoritative inventory of every registered Paseo project as an independent
 * Cube scope. Roots are canonicalized and colliding roots are marked offline.
 */
export async function listProjectScopes(
  paseo: PaseoApi,
): Promise<ProjectScope[]> {
  const { projects } = await paseo.projects.list();
  const scopes = await Promise.all(
    projects.map(async (project): Promise<ProjectScope> => {
      const canonicalRoot = await canonicalizeExistingDirectory(
        project.projectRootPath,
      );
      if (!canonicalRoot) {
        return {
          projectId: project.projectId,
          displayName: preferredDisplayName(project),
          declaredRoot: project.projectRootPath,
          canonicalRoot: project.projectRootPath,
          availability: "offline",
          error: `Project root is unavailable: ${project.projectRootPath}`,
        };
      }
      return {
        projectId: project.projectId,
        displayName: preferredDisplayName(project),
        declaredRoot: project.projectRootPath,
        canonicalRoot,
        availability: "online",
      };
    }),
  );
  markRootCollisions(scopes);
  return scopes;
}

/** Resolves exactly one online scope by id, rejecting unknown or unavailable projects. */
export function resolveProjectId(
  scopes: readonly ProjectScope[],
  projectId: string,
): ProjectScope {
  const scope = scopes.find((candidate) => candidate.projectId === projectId);
  if (!scope) throw new Error(`Unknown Paseo project: ${projectId}`);
  if (scope.availability !== "online") {
    throw new Error(
      scope.error ?? `Paseo project is ${scope.availability}: ${projectId}`,
    );
  }
  return scope;
}

/** Longest registered root path-boundary match for a canonical directory. */
export function matchScopeForRoot(
  scopes: readonly ProjectScope[],
  canonicalRoot: string,
): ProjectScope | undefined {
  const matches = scopes
    .filter(
      (scope) =>
        scope.availability === "online" &&
        (canonicalRoot === scope.canonicalRoot ||
          canonicalRoot.startsWith(`${scope.canonicalRoot}${path.sep}`)),
    )
    .sort(
      (left, right) => right.canonicalRoot.length - left.canonicalRoot.length,
    );
  return matches[0];
}

/** Resolves the owning project for a working directory, or undefined when unregistered. */
export async function resolveProjectForCwd(
  scopes: readonly ProjectScope[],
  cwd: string,
): Promise<ProjectScope | undefined> {
  const canonicalCwd = await canonicalizeRoot(cwd);
  return matchScopeForRoot(scopes, canonicalCwd);
}
