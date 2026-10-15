import { describe, expect, it } from "vitest";

import {
  conductorLabels,
  findConductorId,
  PARENT_AGENT_LABEL,
  workspaceConductorIds,
} from "./labels.js";

const known: Record<string, Record<string, string>> = {
  conductor: conductorLabels,
  worker: { [PARENT_AGENT_LABEL]: "conductor" },
  grandchild: { [PARENT_AGENT_LABEL]: "worker" },
  plain: {},
  stray: { [PARENT_AGENT_LABEL]: "plain" },
  orphan: { [PARENT_AGENT_LABEL]: "missing" },
};
const labelsOf = (id: string) => known[id];

describe("findConductorId", () => {
  it("resolves a conductor, its workers, and their subagents", () => {
    expect(findConductorId("conductor", labelsOf)).toBe("conductor");
    expect(findConductorId("worker", labelsOf)).toBe("conductor");
    expect(findConductorId("grandchild", labelsOf)).toBe("conductor");
  });

  it("ignores subagents of non-conductors and unknown parents", () => {
    expect(findConductorId("plain", labelsOf)).toBeNull();
    expect(findConductorId("stray", labelsOf)).toBeNull();
    expect(findConductorId("orphan", labelsOf)).toBeNull();
  });
});

describe("workspaceConductorIds", () => {
  it("finds conductors in a workspace and the conductors of its workers", () => {
    const agents: Parameters<typeof workspaceConductorIds>[0] = [
      {
        id: "a",
        workspaceId: "main",
        labels: conductorLabels,
        lastActivityAt: "1",
      },
      {
        id: "b",
        workspaceId: "other",
        labels: conductorLabels,
        lastActivityAt: "1",
      },
      {
        id: "w",
        workspaceId: "tree",
        labels: { [PARENT_AGENT_LABEL]: "b" },
        lastActivityAt: "5",
      },
      {
        id: "x",
        workspaceId: "main",
        labels: { [PARENT_AGENT_LABEL]: "b" },
        lastActivityAt: "3",
      },
      { id: "p", workspaceId: "main", labels: {}, lastActivityAt: "9" },
    ];
    expect(workspaceConductorIds(agents, "main")).toEqual(["b", "a"]);
    expect(workspaceConductorIds(agents, "tree")).toEqual(["b"]);
    expect(workspaceConductorIds(agents, "none")).toEqual([]);
  });
});
