import { describe, expect, it, vi } from "vitest";
import {
  LiveActivityTracker,
  type LiveActivitySnapshot,
} from "../src/extensions/live/activity-state.js";

describe("Pi Live semantic activity", () => {
  it("emits revisioned semantic snapshots only when resolved state changes", () => {
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockReturnValue(1_234);
    const snapshots: LiveActivitySnapshot[] = [];
    const tracker = new LiveActivityTracker((snapshot) => snapshots.push(snapshot));

    tracker.setAgentState("thinking");
    tracker.setAgentState("thinking");
    tracker.setAgentState("working");
    tracker.setCheckingSubagents(true);
    tracker.setAgentState("success");
    tracker.setCheckingSubagents(false);
    vi.advanceTimersByTime(1_200);

    expect(snapshots).toEqual([
      { revision: 1, state: "thinking", updatedAt: 1_234 },
      { revision: 2, state: "working", updatedAt: 1_234 },
      { revision: 3, state: "checkingSubagents", updatedAt: 1_234 },
      { revision: 4, state: "success", updatedAt: 1_234 },
      { revision: 5, state: "waiting", updatedAt: 1_234 },
    ]);
    expect(Object.keys(tracker.snapshot).toSorted()).toEqual(["revision", "state", "updatedAt"]);
    tracker.dispose();
    vi.useRealTimers();
  });
});
