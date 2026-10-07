import { describe, expect, it } from "vitest";

import {
  countNeedingAttention,
  groupWorkers,
  relativeTime,
  type WorkerView,
} from "./view-model.js";

function worker(overrides: Partial<WorkerView>): WorkerView {
  return {
    id: "w",
    title: "Worker",
    provider: "claude",
    status: "idle",
    updatedAt: "2026-10-07T10:00:00.000Z",
    attentionReason: null,
    pendingPermissions: [],
    ...overrides,
  };
}

describe("groupWorkers", () => {
  it("puts permission waits first, even while running, and sorts newest first", () => {
    const groups = groupWorkers([
      worker({ id: "idle" }),
      worker({
        id: "old-run",
        status: "running",
        updatedAt: "2026-10-07T09:00:00.000Z",
      }),
      worker({
        id: "new-run",
        status: "running",
        updatedAt: "2026-10-07T11:00:00.000Z",
      }),
      worker({ id: "perm", status: "running", pendingPermissions: [{}] }),
      worker({ id: "err", status: "error" }),
    ]);
    expect(
      groups.map((group) => [group.id, group.workers.map((item) => item.id)]),
    ).toEqual([
      ["needs-you", ["perm"]],
      ["working", ["new-run", "old-run"]],
      ["errored", ["err"]],
      ["idle", ["idle"]],
    ]);
  });

  it("counts workers needing attention", () => {
    expect(
      countNeedingAttention([
        worker({ pendingPermissions: [{}] }),
        worker({ status: "error" }),
        worker({ status: "running" }),
      ]),
    ).toBe(2);
  });
});

describe("relativeTime", () => {
  it("formats minutes, hours, and days", () => {
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    expect(relativeTime("2026-10-07T12:00:00.000Z", now)).toBe("just now");
    expect(relativeTime("2026-10-07T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-10-07T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-10-03T12:00:00.000Z", now)).toBe("4d ago");
  });
});
