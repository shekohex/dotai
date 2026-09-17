import type { PaseoApi, PaseoProject, PaseoWorkspace } from "@getpaseo/client";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  listProjectScopes,
  matchScopeForRoot,
  resolveProjectForCwd,
  resolveProjectId,
} from "./project-registry.js";

function fakeProject(
  projectId: string,
  projectRootPath: string,
  displayName = projectId,
): PaseoProject {
  return {
    projectId,
    projectDisplayName: displayName,
    projectRootPath,
    projectKind: "git",
  } as unknown as PaseoProject;
}

function fakeWorkspace(
  id: string,
  projectId: string,
  projectRootPath: string,
  workspaceDirectory: string,
  archivingAt: string | null = null,
): PaseoWorkspace {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    projectRootPath,
    workspaceDirectory,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    archivingAt,
  } as unknown as PaseoWorkspace;
}

function fakePaseo(
  projects: PaseoProject[],
  workspaces: PaseoWorkspace[] = [],
): {
  paseo: PaseoApi;
  setProjects(next: PaseoProject[]): void;
  setWorkspaces(next: PaseoWorkspace[]): void;
} {
  let current = projects;
  let currentWorkspaces = workspaces;
  return {
    paseo: {
      projects: {
        list: vi.fn(async () => ({ requestId: "test", projects: current })),
      },
      workspaces: {
        list: vi.fn(async () => ({
          requestId: "test",
          entries: currentWorkspaces,
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        })),
      },
    } as unknown as PaseoApi,
    setProjects(next: PaseoProject[]) {
      current = next;
    },
    setWorkspaces(next: PaseoWorkspace[]) {
      currentWorkspaces = next;
    },
  };
}

async function tempRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

describe("project registry inventory", () => {
  it("accepts a live managed workspace as a project-bound scope", async () => {
    const projectRoot = await tempRoot("cube-registry-project-");
    const workspaceRoot = await tempRoot("cube-registry-workspace-");
    const { paseo } = fakePaseo(
      [fakeProject("prj_project", projectRoot)],
      [fakeWorkspace("wks_managed", "prj_project", projectRoot, workspaceRoot)],
    );

    const scopes = await listProjectScopes(paseo);
    const workspaceScope = await resolveProjectForCwd(scopes, workspaceRoot);

    expect(workspaceScope).toMatchObject({
      projectId: "prj_project",
      workspaceId: "wks_managed",
      canonicalRoot: workspaceRoot,
      availability: "online",
    });
  });

  it("uses the longest live workspace root and blocks archived roots", async () => {
    const projectRoot = await tempRoot("cube-registry-nested-project-");
    const workspaceRoot = path.join(projectRoot, "workspace");
    const nestedWorkspaceRoot = path.join(workspaceRoot, "nested");
    await mkdir(nestedWorkspaceRoot, { recursive: true });
    const { paseo } = fakePaseo(
      [fakeProject("prj_nested", projectRoot)],
      [
        fakeWorkspace(
          "wks_workspace",
          "prj_nested",
          projectRoot,
          workspaceRoot,
        ),
        fakeWorkspace(
          "wks_nested",
          "prj_nested",
          projectRoot,
          nestedWorkspaceRoot,
        ),
      ],
    );
    const scopes = await listProjectScopes(paseo);

    expect(
      (await resolveProjectForCwd(scopes, nestedWorkspaceRoot))?.workspaceId,
    ).toBe("wks_nested");
    expect(
      (
        await resolveProjectForCwd(
          scopes,
          path.join(projectRoot, "workspace-other"),
        )
      )?.workspaceId,
    ).toBeUndefined();

    const archivedScopes = await listProjectScopes(
      fakePaseo(
        [fakeProject("prj_nested", projectRoot)],
        [
          fakeWorkspace(
            "wks_workspace",
            "prj_nested",
            projectRoot,
            workspaceRoot,
            "2026-09-17T19:00:00.000Z",
          ),
        ],
      ).paseo,
    );
    expect(await resolveProjectForCwd(archivedScopes, workspaceRoot)).toBe(
      undefined,
    );
  });

  it("treats every registered root as an independent canonical scope", async () => {
    const parent = await tempRoot("cube-registry-parent-");
    const nested = path.join(parent, "nested");
    await mkdir(nested);
    const canonicalNested = await realpath(nested);
    const { paseo } = fakePaseo([
      fakeProject("prj_parent", parent, "Parent"),
      fakeProject("prj_nested", nested, "Nested"),
    ]);

    const scopes = await listProjectScopes(paseo);

    expect(scopes.map((scope) => scope.canonicalRoot)).toEqual([
      parent,
      canonicalNested,
    ]);
    expect(matchScopeForRoot(scopes, canonicalNested)?.projectId).toBe(
      "prj_nested",
    );
    expect(
      matchScopeForRoot(scopes, path.join(parent, "other"))?.projectId,
    ).toBe("prj_parent");
    expect(await resolveProjectForCwd(scopes, nested)).toMatchObject({
      projectId: "prj_nested",
    });
    expect(await resolveProjectForCwd(scopes, os.tmpdir())).toBeUndefined();
  });

  it("marks colliding canonical roots offline and rejects them", async () => {
    const root = await tempRoot("cube-registry-collision-");
    const { paseo } = fakePaseo([
      fakeProject("prj_a", root),
      fakeProject("prj_b", root),
    ]);

    const scopes = await listProjectScopes(paseo);

    expect(scopes.every((scope) => scope.availability === "offline")).toBe(
      true,
    );
    expect(() => resolveProjectId(scopes, "prj_a")).toThrow("ambiguous");
  });

  it("marks a missing root offline and rejects unknown projects", async () => {
    const root = await tempRoot("cube-registry-missing-");
    const { paseo } = fakePaseo([
      fakeProject("prj_ok", root),
      fakeProject("prj_gone", path.join(root, "does-not-exist")),
    ]);

    const scopes = await listProjectScopes(paseo);

    expect(resolveProjectId(scopes, "prj_ok").canonicalRoot).toBe(root);
    expect(() => resolveProjectId(scopes, "prj_gone")).toThrow(
      "Project root is unavailable",
    );
    expect(() => resolveProjectId(scopes, "prj_unknown")).toThrow(
      "Unknown Paseo project",
    );
  });

  it("refreshes inventory when projects are added or removed", async () => {
    const first = await tempRoot("cube-registry-refresh-a-");
    const second = await tempRoot("cube-registry-refresh-b-");
    const { paseo, setProjects } = fakePaseo([fakeProject("prj_a", first)]);

    expect((await listProjectScopes(paseo)).map((s) => s.projectId)).toEqual([
      "prj_a",
    ]);
    setProjects([
      fakeProject("prj_a", first),
      fakeProject("prj_b", second, "Second"),
    ]);
    expect((await listProjectScopes(paseo)).map((s) => s.projectId)).toEqual([
      "prj_a",
      "prj_b",
    ]);
    setProjects([fakeProject("prj_b", second, "Second")]);
    expect((await listProjectScopes(paseo)).map((s) => s.projectId)).toEqual([
      "prj_b",
    ]);
  });

  it("refreshes workspace inventory when workspaces are added or archived", async () => {
    const projectRoot = await tempRoot(
      "cube-registry-workspace-refresh-project-",
    );
    const firstWorkspace = await tempRoot(
      "cube-registry-workspace-refresh-first-",
    );
    const secondWorkspace = await tempRoot(
      "cube-registry-workspace-refresh-second-",
    );
    const { paseo, setWorkspaces } = fakePaseo(
      [fakeProject("prj_workspace_refresh", projectRoot)],
      [
        fakeWorkspace(
          "wks_first",
          "prj_workspace_refresh",
          projectRoot,
          firstWorkspace,
        ),
      ],
    );

    expect(
      (await listProjectScopes(paseo)).filter((scope) => scope.workspaceId),
    ).toHaveLength(1);
    setWorkspaces([
      fakeWorkspace(
        "wks_first",
        "prj_workspace_refresh",
        projectRoot,
        firstWorkspace,
      ),
      fakeWorkspace(
        "wks_second",
        "prj_workspace_refresh",
        projectRoot,
        secondWorkspace,
      ),
    ]);
    expect(
      (await listProjectScopes(paseo))
        .filter((scope) => scope.workspaceId)
        .map((scope) => scope.workspaceId),
    ).toEqual(["wks_first", "wks_second"]);

    setWorkspaces([
      fakeWorkspace(
        "wks_second",
        "prj_workspace_refresh",
        projectRoot,
        secondWorkspace,
        "2026-09-17T19:00:00.000Z",
      ),
    ]);
    const refreshed = await listProjectScopes(paseo);
    expect(
      await resolveProjectForCwd(refreshed, secondWorkspace),
    ).toBeUndefined();
  });
});
