import { beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { createGsdSubagentRuntimeHooks } from "../src/extensions/gsd/ui/subagent-widget.js";

import {
  createDefaultSubagentRuntimeHooks,
  resetSubagentDashboardCoordinatorForTests,
} from "../src/subagent-sdk/runtime-hooks.js";
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

function createCtx(
  scope: string,
  widgets: Map<string, { content: unknown; placement?: string }> = new Map(),
) {
  return {
    cwd: `/tmp/${scope}`,
    hasUI: true,
    sessionManager: {
      getSessionId() {
        return scope;
      },
    },
    ui: {
      theme: createTheme(),
      notify() {},
      async custom() {},
      setWidget(key: string, content: unknown, options?: { placement?: string }) {
        widgets.set(key, { content, placement: options?.placement });
      },
    },
  };
}

function getRenderedWidget(
  widgets: Map<string, { content: unknown; placement?: string }>,
  width = 100,
): string | undefined {
  return renderWidgetContent(widgets.get(SUBAGENT_OVERVIEW_WIDGET_KEY)?.content, width)?.join("\n");
}

function renderWidgetContent(content: unknown, width = 100): string[] | undefined {
  if (content === undefined) {
    return undefined;
  }
  if (Array.isArray(content)) {
    return content as string[];
  }
  const component = (content as (tui: TUI, theme: Theme) => Component)(
    { terminal: { rows: 40 }, requestRender() {} } as TUI,
    createTheme(),
  );
  return component.render(width);
}

describe("subagent ui", () => {
  beforeEach(() => {
    resetSubagentDashboardCoordinatorForTests();
  });

  it("renders active subagent overview above editor", () => {
    const widgets = new Map<string, { content: unknown; placement?: string }>();
    const hooks = createDefaultSubagentRuntimeHooks(createPi() as never);

    hooks.renderWidget(createCtx("subagent-ui-overview", widgets) as never, [
      createRuntimeSubagent({
        sessionId: "a",
        name: "planner",
        status: "running",
        activity: createActivity(),
      }),
      createRuntimeSubagent({ sessionId: "b", name: "mapper", status: "idle" }),
      createRuntimeSubagent({ sessionId: "c", name: "verifier", status: "completed" }),
    ]);

    const widget = widgets.get(SUBAGENT_OVERVIEW_WIDGET_KEY);
    expect(widget?.placement).toBe("aboveEditor");
    const rendered = getRenderedWidget(widgets);
    expect(rendered).toContain("Subagents · 3 active · 1 running · 1 idle · 1 done");
    expect(rendered).toContain("planner · running · gsd-codebase-mapper");
    expect(rendered).toContain("%1 · reading: PROJECT.md");
    expect(rendered).toContain("mapper · idle");
    expect(rendered).toContain("verifier · completed");
  });

  it("aggregates multiple runtime hook widgets and registers controls once per api", () => {
    const commands = new Map<string, unknown>();
    const shortcuts = new Map<string, unknown>();
    const widgets = new Map<string, { content: unknown; placement?: string }>();
    const pi = createPi({
      registerCommand(name: string, options: unknown) {
        commands.set(name, options);
      },
      registerShortcut(shortcut: string, options: unknown) {
        shortcuts.set(shortcut, options);
      },
    });
    const firstHooks = createDefaultSubagentRuntimeHooks(pi as never);
    const secondHooks = createDefaultSubagentRuntimeHooks(pi as never);
    const ctx = createCtx("subagent-ui-multi", widgets);

    firstHooks.renderWidget(ctx as never, [
      createRuntimeSubagent({ sessionId: "first", name: "planner", status: "running" }),
    ]);
    secondHooks.renderWidget(ctx as never, [
      createRuntimeSubagent({ sessionId: "second", name: "reviewer", status: "idle" }),
    ]);

    const rendered = getRenderedWidget(widgets);
    expect(commands.size).toBe(1);
    expect(shortcuts.size).toBe(1);
    expect(rendered).toContain("planner · running");
    expect(rendered).toContain("reviewer · idle");
  });

  it("retains terminal states through persistState after active runtime list clears", async () => {
    vi.useFakeTimers();
    try {
      const widgets = new Map<string, { content: unknown; placement?: string }>();
      const hooks = createDefaultSubagentRuntimeHooks(createPi() as never, {
        terminalRetentionMs: 25,
      });
      const ctx = createCtx("subagent-ui-terminal-retention", widgets);
      const running = createRuntimeSubagent({
        sessionId: "terminal-path",
        name: "executor",
        status: "running",
      });

      hooks.renderWidget(ctx as never, [running]);
      await hooks.persistState({
        ...running,
        event: "completed",
        status: "completed",
        summary: "Done from real persist path",
        completedAt: Date.now(),
      });
      hooks.renderWidget(ctx as never, []);

      expect(getRenderedWidget(widgets)).toContain("executor · completed");

      await vi.advanceTimersByTimeAsync(30);

      expect(widgets.get(SUBAGENT_OVERVIEW_WIDGET_KEY)?.content).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers subagent dashboard command and shortcut controls", () => {
    const commands = new Map<string, { description?: string; handler?: unknown }>();
    const shortcuts = new Map<string, { description?: string }>();
    const duplicateCommands = new Map<string, { description?: string }>();

    createDefaultSubagentRuntimeHooks(
      createPi({
        registerCommand(name: string, options: { description?: string; handler?: unknown }) {
          commands.set(name, options);
        },
        registerShortcut(shortcut: string, options: { description?: string }) {
          shortcuts.set(shortcut, options);
        },
      }) as never,
    );
    createDefaultSubagentRuntimeHooks(
      createPi({
        registerCommand(name: string, options: { description?: string }) {
          duplicateCommands.set(name, options);
        },
      }) as never,
    );

    expect(commands.get("subagents")?.description).toBe("Show or toggle live subagent dashboard");
    expect(shortcuts.get("ctrl+alt+u")?.description).toBe("Toggle subagent dashboard");
    expect(duplicateCommands.size).toBe(0);
  });

  it("dashboard command renders only current session scope", async () => {
    const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
    const sessionAWidgets = new Map<string, { content: unknown; placement?: string }>();
    const sessionBWidgets = new Map<string, { content: unknown; placement?: string }>();
    const pi = createPi({
      registerCommand(
        name: string,
        options: { handler(args: string, ctx: unknown): Promise<void> },
      ) {
        commands.set(name, options);
      },
    });
    const sessionAHooks = createDefaultSubagentRuntimeHooks(pi as never);
    const sessionBHooks = createDefaultSubagentRuntimeHooks(pi as never);
    const sessionACtx = createCtx("session-a", sessionAWidgets);
    const sessionBCtx = createCtx("session-b", sessionBWidgets);

    sessionAHooks.renderWidget(sessionACtx as never, [
      createRuntimeSubagent({ sessionId: "a", name: "session-a-agent", status: "running" }),
    ]);
    sessionBHooks.renderWidget(sessionBCtx as never, [
      createRuntimeSubagent({ sessionId: "b", name: "session-b-agent", status: "running" }),
    ]);

    await commands.get("subagents")?.handler("toggle", sessionBCtx);

    const renderedSessionB = getRenderedWidget(sessionBWidgets);
    expect(renderedSessionB).toContain("session-b-agent");
    expect(renderedSessionB).not.toContain("session-a-agent");
  });

  it("disposing hooks removes stale rows and clears scoped widget", () => {
    const widgets = new Map<string, { content: unknown; placement?: string }>();
    const hooks = createDefaultSubagentRuntimeHooks(createPi() as never);
    const ctx = createCtx("subagent-ui-dispose", widgets);

    hooks.renderWidget(ctx as never, [
      createRuntimeSubagent({ sessionId: "stale", name: "stale-agent", status: "running" }),
    ]);
    expect(getRenderedWidget(widgets)).toContain("stale-agent");

    hooks.dispose?.();

    expect(widgets.get(SUBAGENT_OVERVIEW_WIDGET_KEY)?.content).toBeUndefined();

    hooks.renderWidget(ctx as never, [
      createRuntimeSubagent({ sessionId: "restored", name: "restored-agent", status: "running" }),
    ]);

    expect(getRenderedWidget(widgets)).toContain("restored-agent");
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

    const rendered = lines?.join("\n");
    expect(rendered).toContain("─── 🤖 subagents");
    expect(rendered).toContain("Agents: 1  0 running  0 idle  0 done  1 failed");
    expect(rendered).toContain("Longest: ★ reviewer");
    expect(rendered).toContain("#  name");
    expect(rendered).toContain("activity / summary");
    expect(rendered).toContain("────────────────");
    expect(rendered).toContain("reviewer");
    expect(rendered).toContain("%1");
    expect(rendered).toContain("failed");
    expect(rendered).toContain("Map codebase");
    expect(rendered).toContain("Tests failed in subagent");
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

  it("calculates themed title hint width by visible width", () => {
    const ansiTheme = {
      bg(_color: string, text: string) {
        return text;
      },
      fg(_color: string, text: string) {
        return `\u001b[2m${text}\u001b[22m`;
      },
      bold(text: string) {
        return `\u001b[1m${text}\u001b[22m`;
      },
    } as Theme;
    const lines = renderSubagentDashboardLines(
      [createRuntimeSubagent({ sessionId: "ansi", name: "runner", status: "running" })],
      78,
      ansiTheme,
      { mode: "compact" },
    );

    expect(lines?.[0]).toContain("ctrl+alt+u");
    expect(visibleWidth(lines?.[0] ?? "")).toBeLessThanOrEqual(78);
  });

  it("shows combined expanded header hint at normal width", () => {
    const lines = renderSubagentDashboardLines(
      [createRuntimeSubagent({ sessionId: "hint", name: "runner", status: "running" })],
      120,
      createTheme(),
      { mode: "expanded" },
    );

    expect(lines?.[0]).toContain("ctrl+alt+u collapse");
    expect(lines?.[0]).toContain("/subagents fullscreen");
    expect(lines?.[0]).not.toContain("…");
    expect(visibleWidth(lines?.[0] ?? "")).toBeLessThanOrEqual(120);
  });

  it("caps rows with hidden subagent count", () => {
    const lines = renderSubagentDashboardLines(
      Array.from({ length: 6 }, (_, index) =>
        createRuntimeSubagent({
          sessionId: `overflow-${index}`,
          name: `agent-${index}`,
          status: "running",
        }),
      ),
      100,
      createTheme(),
      { mode: "compact", maxRows: 4 },
    );

    expect(lines).toHaveLength(4);
    expect(lines?.at(-1)).toContain("… 4 hidden subagents");
  });

  it("renders expanded dashboard with item-level elision", () => {
    const lines = renderSubagentDashboardLines(
      Array.from({ length: 6 }, (_, index) =>
        createRuntimeSubagent({
          sessionId: `expanded-overflow-${index}`,
          name: `agent-${index}`,
          status: index === 5 ? "failed" : "running",
          summary: index === 5 ? "terminal summary stays on same row" : undefined,
          completedAt: index === 5 ? 2 : undefined,
        }),
      ),
      110,
      createTheme(),
      { mode: "expanded", maxRows: 2 },
    );
    const rendered = lines?.join("\n");

    expect(rendered).toContain("… 4 hidden subagents");
    expect(rendered).toContain("agent-0");
    expect(rendered).toContain("agent-1");
    expect(rendered).not.toContain("5  agent-4");
    expect(rendered).not.toContain("6  agent-5");
  });

  it("prioritizes live expanded rows over retained terminal rows", () => {
    const lines = renderSubagentDashboardLines(
      [
        ...Array.from({ length: 4 }, (_, index) =>
          createRuntimeSubagent({
            sessionId: `running-${index}`,
            name: `running-${index}`,
            status: "running",
          }),
        ),
        ...Array.from({ length: 4 }, (_, index) =>
          createRuntimeSubagent({
            sessionId: `done-${index}`,
            name: `done-${index}`,
            status: "completed",
            completedAt: 2,
          }),
        ),
      ],
      110,
      createTheme(),
      { mode: "expanded", maxRows: 4 },
    );
    const rendered = lines?.join("\n");

    expect(rendered).toContain("running-0");
    expect(rendered).toContain("running-3");
    expect(rendered).not.toContain("done-0     ");
    expect(rendered).toContain("… 4 hidden subagents");
  });

  it("keeps expanded dashboard bounded in narrow terminals", () => {
    const lines = renderSubagentDashboardLines(
      Array.from({ length: 6 }, (_, index) =>
        createRuntimeSubagent({
          sessionId: `narrow-expanded-${index}`,
          name: `agent-${index}`,
          status: "running",
          activity: createActivity({
            label: "reading",
            detail: `packages/some/very/long/path/for/agent-${index}/README.md`,
          }),
        }),
      ),
      60,
      createTheme(),
      { mode: "expanded", maxRows: 4 },
    );

    expect(lines).toBeDefined();
    expect(lines?.length).toBeLessThanOrEqual(12);
    expect(lines?.every((line) => visibleWidth(line) <= 60)).toBe(true);
    expect(lines?.join("\n")).toContain("agent-0");
  });

  it("keeps one expanded activity continuation within budget", () => {
    const lines = renderSubagentDashboardLines(
      Array.from({ length: 4 }, (_, index) =>
        createRuntimeSubagent({
          sessionId: `activity-wrap-${index}`,
          name: `agent-${index}`,
          status: "running",
          activity: createActivity({
            label: "reading",
            detail: `packages/some/very/long/path/for/agent-${index}/README.md`,
          }),
        }),
      ),
      60,
      createTheme(),
      { mode: "expanded", maxRows: 4 },
    );
    const activityLineCount = lines?.filter((line) => line.includes("Activity:")).length ?? 0;
    const continuationLineCount = lines?.filter((line) => line.includes("agent-1")).length ?? 0;

    expect(lines?.length).toBeLessThanOrEqual(12);
    expect(activityLineCount).toBe(1);
    expect(continuationLineCount).toBeGreaterThan(0);
  });

  it("splits completed failed and cancelled summary counts", () => {
    const rendered = renderSubagentDashboardLines(
      [
        createRuntimeSubagent({
          sessionId: "completed-a",
          name: "completed-a",
          status: "completed",
        }),
        createRuntimeSubagent({ sessionId: "failed-a", name: "failed-a", status: "failed" }),
        createRuntimeSubagent({
          sessionId: "cancelled-a",
          name: "cancelled-a",
          status: "cancelled",
        }),
        createRuntimeSubagent({
          sessionId: "completed-b",
          name: "completed-b",
          status: "completed",
        }),
        createRuntimeSubagent({ sessionId: "failed-b", name: "failed-b", status: "failed" }),
        createRuntimeSubagent({
          sessionId: "cancelled-b",
          name: "cancelled-b",
          status: "cancelled",
        }),
      ],
      120,
      createTheme(),
      { mode: "expanded", maxRows: 2 },
    )?.join("\n");

    expect(rendered).toContain("2 done  2 failed  2 cancelled");
    expect(rendered).not.toContain("6 done");
    expect(rendered).toContain("… 4 hidden subagents");
  });

  it("shows handoff and completion metadata", () => {
    const subagent = createRuntimeSubagent({
      sessionId: "metadata",
      name: "agentx",
      status: "running",
      handoff: true,
      completion: { deliverAs: "followUp" },
    });
    const compact = renderSubagentDashboardLines([subagent], 120, createTheme(), {
      mode: "compact",
    })?.join("\n");
    const expanded = renderSubagentDashboardLines([subagent], 120, createTheme(), {
      mode: "expanded",
    })?.join("\n");

    expect(compact).toContain("handoff");
    expect(compact).toContain("followUp");
    expect(expanded).toContain("handoff");
    expect(expanded).toContain("followUp");
  });

  it("keeps long elapsed values in aligned table columns", () => {
    const now = Date.now();
    const rendered = renderSubagentDashboardLines(
      [
        createRuntimeSubagent({
          sessionId: "long-running",
          name: "long-running",
          status: "running",
          startedAt: now - 100 * 60 * 60 * 1000,
          updatedAt: now,
        }),
      ],
      120,
      createTheme(),
      { mode: "expanded" },
    )?.join("\n");

    expect(rendered).toContain("100h 0m 0s %1");
    expect(rendered).not.toContain("100h 0m 0s%1");
  });

  it("truncates long pane ids before status column", () => {
    const rendered = renderSubagentDashboardLines(
      [
        createRuntimeSubagent({
          sessionId: "long-pane",
          name: "long-pane",
          status: "running",
          paneId: "pty:12345:mabc:verylongpaneid",
        }),
      ],
      120,
      createTheme(),
      { mode: "expanded" },
    )?.join("\n");

    expect(rendered).toMatch(/pty:.*running/u);
    expect(rendered).not.toContain("verylongpaneidrunning");
  });

  it("GSD subagent hooks delegate to shared dashboard with GSD title", () => {
    const widgets = new Map<string, { content: unknown; placement?: string }>();
    const hooks = createGsdSubagentRuntimeHooks(createPi() as never);

    hooks.renderWidget(createCtx("gsd-subagent-shared-title", widgets) as never, [
      createRuntimeSubagent({ sessionId: "gsd", name: "gsd-planner", status: "running" }),
    ]);

    expect(getRenderedWidget(widgets)).toContain("GSD Subagents · 1 active · 1 running");
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
        terminal: { rows: 12 },
        requestRender() {
          renderRequests += 1;
        },
      } as TUI,
      createTheme(),
    );

    const firstLines = component.render(80);
    const first = firstLines.join("\n");
    component.handleInput?.("\u001b[6~");
    const second = component.render(80).join("\n");
    component.handleInput?.("q");

    expect(firstLines).toHaveLength(9);
    expect(first).toContain("─── 🤖 subagents");
    expect(first).toContain("Agents: 12");
    expect(second).toContain("esc close");
    expect(second).toContain("/");
    expect(renderRequests).toBe(1);
    expect(closed).toBe(true);
  });

  it("fullscreen renders all subagent rows without hidden elision", () => {
    const component = createSubagentFullscreenComponent({
      subagents: Array.from({ length: 12 }, (_, index) =>
        createRuntimeSubagent({
          sessionId: `fullscreen-${index}`,
          name: `fullscreen-${index}`,
          status: "running",
        }),
      ),
      done() {},
    })({ terminal: { rows: 12 }, requestRender() {} } as TUI, createTheme());

    const first = component.render(100).join("\n");
    component.handleInput?.("G");
    const last = component.render(100).join("\n");

    expect(first).not.toContain("hidden subagents");
    expect(last).not.toContain("hidden subagents");
    expect(last).toContain("fullscreen-11");
  });

  it("fullscreen component renders live subagent updates without reopening", () => {
    let subagents = [
      createRuntimeSubagent({ sessionId: "live-fullscreen", name: "worker", status: "running" }),
    ];
    const component = createSubagentFullscreenComponent({
      subagents,
      getSubagents() {
        return subagents;
      },
      done() {},
    })({ terminal: { rows: 40 }, requestRender() {} } as TUI, createTheme());

    expect(component.render(100).join("\n")).toContain("Map codebase");

    subagents = [
      createRuntimeSubagent({
        sessionId: "live-fullscreen",
        name: "worker",
        status: "failed",
        activity: createActivity({ label: "failed", detail: "Tool crashed" }),
        summary: "Tool crashed",
        completedAt: 2,
      }),
    ];

    const updated = component.render(100).join("\n");
    expect(updated).toContain("worker");
    expect(updated).toContain("failed");
    expect(updated).toContain("failed: Tool crashed");
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

    hooks.renderWidget(createCtx("subagent-ui-live-runtime", widgets) as never, [
      createRuntimeSubagent({ sessionId: "live", name: "mapper", status: "running" }),
    ]);

    expect(widgets.has(SUBAGENT_OVERVIEW_WIDGET_KEY)).toBe(true);
  });
});
