import { describe, expect, it } from "vitest";

import { createDefaultSubagentRuntimeHooks } from "../src/subagent-sdk/runtime-hooks.js";
import {
  SUBAGENT_OVERVIEW_WIDGET_KEY,
  SUBAGENT_WIDGET_KEY,
  type SubagentActivityEntry,
  type RuntimeSubagent,
} from "../src/subagent-sdk/types.js";
import { renderChildSessionWidget } from "../src/subagent-sdk/ui.js";

function createRuntimeSubagent(
  overrides: Partial<RuntimeSubagent> & Pick<RuntimeSubagent, "sessionId" | "name" | "status">,
): RuntimeSubagent {
  return {
    event: "started",
    sessionId: overrides.sessionId,
    sessionPath: "/tmp/child.jsonl",
    persisted: true,
    parentSessionId: "parent-session-id",
    parentSessionPath: "/tmp/parent.jsonl",
    name: overrides.name,
    mode: "gsd-codebase-mapper",
    modeLabel: "gsd-codebase-mapper",
    cwd: "/tmp/project",
    paneId: "%1",
    task: "Map codebase",
    handoff: false,
    autoExit: true,
    autoExitTimeoutMs: 30_000,
    autoExitTimeoutActive: false,
    status: overrides.status,
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createActivity(overrides: Partial<SubagentActivityEntry> = {}): SubagentActivityEntry {
  return {
    sessionId: "a",
    kind: "tool",
    label: "reading",
    detail: "PROJECT.md",
    startedAt: 1,
    updatedAt: 2,
    done: false,
    ...overrides,
  };
}

describe("subagent ui", () => {
  it("renders active subagent overview above editor and full list below editor", () => {
    const widgets = new Map<string, { content: string[] | undefined; placement?: string }>();
    const hooks = createDefaultSubagentRuntimeHooks({
      appendEntry() {},
      sendMessage() {},
    } as never);

    hooks.renderWidget(
      {
        hasUI: true,
        ui: {
          setWidget(key: string, content: string[] | undefined, options?: { placement?: string }) {
            widgets.set(key, { content, placement: options?.placement });
          },
        },
      } as never,
      [
        createRuntimeSubagent({
          sessionId: "a",
          name: "planner",
          status: "running",
          activity: createActivity(),
        }),
        createRuntimeSubagent({ sessionId: "b", name: "mapper", status: "idle" }),
        createRuntimeSubagent({ sessionId: "c", name: "verifier", status: "completed" }),
      ],
    );

    expect(widgets.get(SUBAGENT_OVERVIEW_WIDGET_KEY)).toEqual({
      content: ["Subagents active: 3 · 1 running · 1 idle · planner, mapper, verifier"],
      placement: "aboveEditor",
    });
    expect(widgets.get(SUBAGENT_WIDGET_KEY)?.placement).toBe("belowEditor");
    expect(widgets.get(SUBAGENT_WIDGET_KEY)?.content?.[0]).toBe("Subagents (3)");
    expect(
      widgets
        .get(SUBAGENT_WIDGET_KEY)
        ?.content?.some((line) => line.includes("reading: PROJECT.md")),
    ).toBe(true);
  });

  it("renders child session badge with subagent label", () => {
    expect(
      renderChildSessionWidget({
        sessionId: "child-session-id",
        parentSessionId: "parent-session-id",
        name: "codebase-mapper",
        prompt: "Map architecture",
        mode: "gsd-codebase-mapper",
        autoExit: true,
        handoff: false,
        tools: ["read", "bash"],
        startedAt: 1,
      }),
    ).toEqual(["Subagent session · codebase-mapper · gsd-codebase-mapper"]);
  });

  it("renders widgets during live runtime operations with parent ui context", async () => {
    const widgets = new Map<string, { content: unknown; placement?: string }>();
    const hooks = createDefaultSubagentRuntimeHooks({
      appendEntry() {},
      sendMessage() {},
    } as never);

    hooks.renderWidget(
      {
        hasUI: true,
        ui: {
          setWidget(key: string, content: unknown, options?: { placement?: string }) {
            widgets.set(key, { content, placement: options?.placement });
          },
        },
      } as never,
      [createRuntimeSubagent({ sessionId: "live", name: "mapper", status: "running" })],
    );

    expect(widgets.has(SUBAGENT_OVERVIEW_WIDGET_KEY)).toBe(true);
    expect(widgets.has(SUBAGENT_WIDGET_KEY)).toBe(true);
  });
});
