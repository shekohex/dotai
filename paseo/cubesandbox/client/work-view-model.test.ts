import { describe, expect, it } from "vitest";

import {
  idleLabel,
  primaryLifecycleAction,
  type WorkSummaryView,
} from "./work-view-model.js";

const work: WorkSummaryView = {
  workId: "work-1",
  sandboxId: "sandbox-1",
  projectId: "widget",
  repository: "acme/widget",
  status: "ready",
  idleTimeoutSeconds: 300,
  updatedAt: "2026-09-16T00:00:00.000Z",
  worktreeCount: 2,
  agentCount: 2,
  agents: [],
  previewUrls: [],
};

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
});
