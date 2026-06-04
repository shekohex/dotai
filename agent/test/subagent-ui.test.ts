import { describe, expect, it } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";

import { createDefaultSubagentRuntimeHooks } from "../src/subagent-sdk/runtime-hooks.js";
import {
  SUBAGENT_OVERVIEW_WIDGET_KEY,
  type SubagentActivityEntry,
  type RuntimeSubagent,
} from "../src/subagent-sdk/types.js";
import {
  createSubagentFullscreenComponent,
  mergeSubagentsWithTerminalRetention,
  renderChildSessionWidget,
  renderSubagentDashboardLines,
} from "../src/subagent-sdk/ui.js";

initTheme("dark");

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

function createTheme(): Theme {
  return {
    bg(_color, text) {
      return text;
    },
    fg(_color, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  } as Theme;
}

function createPi(overrides: Record<string, unknown> = {}) {
  return {
    appendEntry() {},
    sendMessage() {},
    registerCommand() {},
    registerShortcut() {},
    ...overrides,
  };
}

function renderWidgetContent(content: unknown, width = 100): string[] | undefined {
  if (content === undefined) {
    return undefined;
  }
  if (Array.isArray(content)) {
    return content as string[];
  }
  const component = (content as (tui: TUI, theme: Theme) => Component)(
    { requestRender() {} } as TUI,
    createTheme(),
  );
  return component.render(width);
}

describe("subagent ui", () => {
  it("renders active subagent overview above editor", () => {
    const widgets = new Map<string, { content: unknown; placement?: string }>();
    const hooks = createDefaultSubagentRuntimeHooks(createPi() as never);

    hooks.renderWidget(
      {
        hasUI: true,
        ui: {
          setWidget(key: string, content: unknown, options?: { placement?: string }) {
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

    const widget = widgets.get(SUBAGENT_OVERVIEW_WIDGET_KEY);
    expect(widget?.placement).toBe("aboveEditor");
    const rendered = renderWidgetContent(widget?.content)?.join("\n");
    expect(rendered).toContain("Subagents · 3 active · 1 running · 1 idle · 1 done");
    expect(rendered).toContain("planner · running · gsd-codebase-mapper");
    expect(rendered).toContain("%1 · reading: PROJECT.md");
    expect(rendered).toContain("mapper · idle");
    expect(rendered).toContain("verifier · completed");
  });

  it("registers subagent dashboard command and shortcut controls", () => {
    const commands = new Map<string, { description?: string }>();
    const shortcuts = new Map<string, { description?: string }>();

    createDefaultSubagentRuntimeHooks(
      createPi({
        registerCommand(name: string, options: { description?: string }) {
          commands.set(name, options);
        },
        registerShortcut(shortcut: string, options: { description?: string }) {
          shortcuts.set(shortcut, options);
        },
      }) as never,
    );

    expect(commands.get("subagents")?.description).toBe("Show or toggle live subagent dashboard");
    expect(shortcuts.get("ctrl+alt+a")?.description).toBe("Toggle subagent dashboard");
  });

  it("renders expanded actionable rows with terminal summaries", () => {
    const lines = renderSubagentDashboardLines(
      [
        createRuntimeSubagent({
          sessionId: "failed",
          name: "reviewer",
          status: "failed",
          completedAt: 2,
          summary: "Tests failed in subagent run",
        }),
      ],
      100,
      createTheme(),
      { mode: "expanded" },
    );

    expect(lines?.join("\n")).toContain("reviewer · failed · gsd-codebase-mapper");
    expect(lines?.join("\n")).toContain("%1");
    expect(lines?.join("\n")).toContain("Map codebase");
    expect(lines?.join("\n")).toContain("Tests failed in subagent run");
  });

  it("keeps compact widget readable in narrow terminals", () => {
    const lines = renderSubagentDashboardLines(
      [
        createRuntimeSubagent({
          sessionId: "narrow",
          name: "very-long-subagent-name",
          status: "running",
          activity: createActivity({
            detail: "a very long file path that should not overflow narrow terminals",
          }),
        }),
      ],
      36,
      createTheme(),
      { mode: "compact" },
    );

    expect(lines).toBeDefined();
    expect(lines?.every((line) => visibleWidth(line) <= 36)).toBe(true);
    expect(lines?.join("\n")).toContain("Subagents · 1 active");
  });

  it("retains recent terminal subagents after active list clears", () => {
    const terminal = createRuntimeSubagent({
      sessionId: "done",
      name: "executor",
      status: "completed",
      completedAt: 10,
      updatedAt: 10,
      summary: "Implemented task",
    });

    expect(
      mergeSubagentsWithTerminalRetention({
        previous: [terminal],
        next: [],
        now: 20,
        retentionMs: 15,
      }),
    ).toEqual([terminal]);
    expect(
      mergeSubagentsWithTerminalRetention({
        previous: [terminal],
        next: [],
        now: 30,
        retentionMs: 15,
      }),
    ).toEqual([]);
  });

  it("fullscreen component scrolls and closes explicitly", () => {
    let closed = false;
    let renderRequests = 0;
    const component = createSubagentFullscreenComponent({
      subagents: Array.from({ length: 12 }, (_, index) =>
        createRuntimeSubagent({
          sessionId: `agent-${index}`,
          name: `agent-${index}`,
          status: index === 0 ? "running" : "completed",
          completedAt: 2,
        }),
      ),
      done() {
        closed = true;
      },
    })(
      {
        requestRender() {
          renderRequests += 1;
        },
      } as TUI,
      createTheme(),
    );

    const first = component.render(80).join("\n");
    component.handleInput?.("\u001b[6~");
    const second = component.render(80).join("\n");
    component.handleInput?.("q");

    expect(first).toContain("Subagents");
    expect(second).toContain("esc close");
    expect(renderRequests).toBe(1);
    expect(closed).toBe(true);
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
    const hooks = createDefaultSubagentRuntimeHooks(createPi() as never);

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
  });
});
