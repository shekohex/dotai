import type { PaseoApi, PaseoProject } from "@getpaseo/client";
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

function fakePaseo(projects: PaseoProject[]): {
  paseo: PaseoApi;
  setProjects(next: PaseoProject[]): void;
} {
  let current = projects;
  return {
    paseo: {
      projects: {
        list: vi.fn(async () => ({ requestId: "test", projects: current })),
      },
    } as unknown as PaseoApi,
    setProjects(next: PaseoProject[]) {
      current = next;
    },
  };
}

async function tempRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

describe("project registry inventory", () => {
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
});
