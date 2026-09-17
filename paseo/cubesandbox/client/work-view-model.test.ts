import { describe, expect, it } from "vitest";

import {
  canInitializeProject,
  canManageProjectWork,
  idleLabel,
  primaryLifecycleAction,
  projectAvailabilityLabel,
  projectCountsLabel,
  projectIdentityLabel,
  projectReadinessLabel,
  resolveSelectedProjectId,
  visibleProjects,
  type CubeProjectSummaryView,
  type WorkSummaryView,
} from "./work-view-model.js";

const work: WorkSummaryView = {
  workId: "work-1",
  sandboxId: "sandbox-1",
  paseoProjectId: "prj_1",
  cubeProjectId: "widget",
  repository: "acme/widget",
  status: "ready",
  idleTimeoutSeconds: 300,
  updatedAt: "2026-09-16T00:00:00.000Z",
  worktreeCount: 2,
  agentCount: 2,
  agents: [],
  previewUrls: [],
};

function project(
  overrides: Partial<CubeProjectSummaryView> = {},
): CubeProjectSummaryView {
  return {
    projectId: "prj_1",
    displayName: "Widget",
    availability: "online",
    configStatus: "ready",
    cubeProjectId: "widget",
    repository: "acme/widget",
    canonicalRoot: "/repo/widget",
    counts: { work: 1, busy: 1, paused: 0 },
    works: [work],
    ...overrides,
  };
}

describe("work view model", () => {
  it("maps paused and active states to lifecycle actions", () => {
    expect(primaryLifecycleAction("paused")).toBe("resume");
    expect(primaryLifecycleAction("ready")).toBe("pause");
    expect(primaryLifecycleAction("creating")).toBeNull();
  });

  it("shows remaining idle grace", () => {
    expect(idleLabel(work, Date.parse("2026-09-16T00:01:01.000Z"))).toBe(
      "Idle pause in 4m",
    );
  });

  it("shows keepalive instead of an idle countdown while busy", () => {
    expect(idleLabel({ ...work, status: "busy" })).toBe("Keepalive active");
  });

  it("resolves a live selection and falls back for a removed project", () => {
    const projects = [
      project(),
      project({ projectId: "prj_2", displayName: "Two" }),
    ];
    expect(resolveSelectedProjectId(projects, "prj_2")).toBe("prj_2");
    expect(resolveSelectedProjectId(projects, "prj_removed")).toBeNull();
    expect(resolveSelectedProjectId(projects, null)).toBeNull();
  });

  it("groups all projects or focuses the selected project", () => {
    const first = project();
    const second = project({ projectId: "prj_2", displayName: "Two" });
    expect(visibleProjects([first, second], null)).toHaveLength(2);
    expect(visibleProjects([first, second], "prj_2")).toEqual([second]);
    expect(visibleProjects([first, second], "prj_removed")).toHaveLength(2);
  });

  it("enables initialization only for online projects missing config", () => {
    expect(canInitializeProject(project({ configStatus: "missing" }))).toBe(
      true,
    );
    expect(canInitializeProject(project({ configStatus: "ready" }))).toBe(
      false,
    );
    expect(
      canInitializeProject(
        project({ configStatus: "missing", availability: "removed" }),
      ),
    ).toBe(false);
    expect(canManageProjectWork(project())).toBe(true);
    expect(canManageProjectWork(project({ availability: "offline" }))).toBe(
      false,
    );
  });

  it("labels readiness, availability, identity, and counts", () => {
    expect(projectReadinessLabel(project({ configStatus: "missing" }))).toBe(
      "Configuration missing",
    );
    expect(projectReadinessLabel(project({ configStatus: "invalid" }))).toBe(
      "Configuration invalid",
    );
    expect(projectAvailabilityLabel(project())).toBeNull();
    expect(projectAvailabilityLabel(project({ availability: "removed" }))).toBe(
      "Project removed",
    );
    expect(projectIdentityLabel(project())).toBe("acme/widget · widget");
    expect(projectIdentityLabel(project({ repository: undefined }))).toBe(
      "widget",
    );
    expect(projectCountsLabel(project())).toBe("1 work · 1 busy · 0 paused");
  });
});
