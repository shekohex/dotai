import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  createGsdHelpComponent,
  getGsdHelpReference,
  showGsdHelp,
} from "../../src/extensions/gsd/help.js";
import gsdExtension from "../../src/extensions/gsd/index.ts";
import { handleGsdStatus } from "../../src/extensions/gsd/instant/status.ts";
import { setGsdSubagentSdkFactoryForTests } from "../../src/extensions/gsd/subagents.ts";
import { showGsdDashboard } from "../../src/extensions/gsd/ui.js";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

const fakeHelpPi = {
  sendMessage() {},
};

initTheme("dark");

function createRoot(): string {
  const root = createTempDirSync("agent-gsd-ui-");
  mkdirSync(join(root, ".planning", "goals", "active"), { recursive: true });
  mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
  mkdirSync(join(root, ".planning", "milestones", "v1.0-mvp"), { recursive: true });
  mkdirSync(join(root, ".planning", "todos", "pending"), { recursive: true });
  writeFileSync(
    join(root, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
  );
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 01-01\nstatus: Ready to execute\n",
  );
  writeFileSync(
    join(root, ".planning", "ROADMAP.md"),
    `# Roadmap: Demo

### Phase 1: Foundation
**Goal**: Build base

Plans:
- [ ] 01-01: Create base
`,
  );
  writeFileSync(
    join(root, ".planning", "phases", "1-foundation", "01-01-PLAN.md"),
    "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/index.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
  );
  writeFileSync(join(root, ".planning", "goals", "v1.0-launch.md"), "launch\n");
  writeFileSync(join(root, ".planning", "todos", "pending", "20260504-base.md"), "base\n");
  return root;
}

function writeProjectFiles(root: string): void {
  writeFileSync(
    join(root, ".planning", "PROJECT.md"),
    "## What This Is\n\nDemo\n\n## Core Value\n\nValue\n\n## Requirements\n\n- One\n",
  );
  writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
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

function createTui(): TUI {
  return {
    requestRender() {},
  } as TUI;
}

function renderMessage(
  renderer: MessageRenderer,
  message: { content: string; customType: string },
): string {
  const component = renderer(message, { expanded: true }, createTheme());
  return component.render(100).join("\n");
}

async function renderCustomComponent(
  custom: (tui: TUI, theme: Theme, kb: unknown, done: () => void) => Component | Promise<Component>,
): Promise<string> {
  const component = await custom(createTui(), createTheme(), undefined, () => {});
  return component.render(100).join("\n");
}

describe("gsd ui custom components", () => {
  it("dashboard custom ui renders planning summary, todos, and docs", async () => {
    const cwd = createRoot();
    let rendered = "";
    await showGsdDashboard({
      cwd,
      hasUI: true,
      ui: {
        notify() {},
        async custom(custom) {
          rendered = await renderCustomComponent(custom);
        },
      },
    } as never);
    expect(rendered).toContain("GSD");
    expect(rendered).toContain("Current Phase");
    expect(rendered).toContain("Milestones");
    expect(rendered).toContain("v1.0-mvp");
    expect(rendered).toContain("Goals");
    expect(rendered).toContain("v1.0-launch.md");
    expect(rendered).toContain("Pending Todos");
    expect(rendered).toContain("20260504-base.md");
    expect(rendered).toContain("Docs (1/8)");
  });

  it("dashboard custom ui preserves degraded health state in summary", async () => {
    const cwd = createRoot();
    writeProjectFiles(cwd);
    let rendered = "";
    await showGsdDashboard({
      cwd,
      hasUI: true,
      ui: {
        notify() {},
        async custom(custom) {
          rendered = await renderCustomComponent(custom);
        },
      },
    } as never);
    expect(rendered).toContain("Health: degraded");
  });

  it("help custom ui renders canonical command reference", async () => {
    let rendered = "";
    await showGsdHelp(
      fakeHelpPi as never,
      {
        cwd: createRoot(),
        hasUI: true,
        ui: {
          notify() {},
          async custom(custom) {
            rendered = await renderCustomComponent(custom);
          },
        },
      } as never,
    );
    const reference = getGsdHelpReference();
    expect(rendered).toContain("# GSD Command Reference");
    expect(rendered).toContain("## Upstream Crosswalk");
    expect(rendered).toContain("## Unsupported Upstream Commands");
    expect(rendered).toContain("PgUp/PgDn page");
    expect(reference).toContain("## Milestones");
    expect(reference).toContain("## Planning");
    expect(reference).toContain("/gsd new-milestone");
    expect(reference).toContain("/gsd complete-milestone");
    expect(reference).toContain("/gsd milestone-summary");
    expect(reference).toContain("/gsd debug status <slug>");
    expect(reference).toContain("/gsd secure-phase [phase]");
    expect(reference).toContain("/gsd status");
    expect(rendered).not.toContain("Docs (");
    expect(rendered).not.toContain("overview.md");
  });

  it("registered non-ui help renderer has clear durable handling path", () => {
    const messageRenderers = new Map<string, unknown>();
    gsdExtension({
      registerCommand() {},
      registerMessageRenderer(customType: string, renderer: unknown) {
        messageRenderers.set(customType, renderer);
      },
      on() {},
    } as never);

    const renderer = messageRenderers.get("gsd-help");
    expect(renderer).toBeTypeOf("function");

    const rendered = renderMessage(renderer as MessageRenderer, {
      customType: "gsd-help",
      content: getGsdHelpReference(),
    });

    expect(rendered).toContain("GSD Help");
    expect(rendered).toContain("# GSD Command Reference");
    expect(rendered).toContain("## Unsupported Upstream Commands");
  });

  it("help component pages through canonical reference", () => {
    const component = createGsdHelpComponent(() => {});

    const firstPage = component.render(100).join("\n");
    expect(firstPage).toContain("# GSD Command Reference");
    expect(firstPage).toContain("## Upstream Crosswalk");
    expect(firstPage).not.toContain("## Execution");
    expect(firstPage).not.toContain("## Debug");
    expect(firstPage).not.toContain("## Instant");

    component.handleInput?.("\u001b[6~");

    const secondPage = component.render(100).join("\n");
    expect(secondPage).toContain("## Quick Start");
    expect(secondPage).not.toContain("## Debug");

    let sawExecution = false;
    let sawDebug = false;

    for (let page = 0; page < 8; page += 1) {
      component.handleInput?.("\u001b[6~");
      const renderedPage = component.render(100).join("\n");
      sawExecution ||= renderedPage.includes("/gsd secure-phase [phase]");
      sawDebug ||= renderedPage.includes("## Debug");
      if (sawExecution && sawDebug) {
        break;
      }
    }

    expect(sawExecution).toBe(true);
    expect(sawDebug).toBe(true);

    component.handleInput?.("\u001b[5~");
    component.handleInput?.("\u001b[5~");
    component.handleInput?.("\u001b[5~");
    component.handleInput?.("\u001b[5~");
    component.handleInput?.("\u001b[5~");

    const backToFirstPage = component.render(100).join("\n");
    expect(backToFirstPage).toContain("# GSD Command Reference");
    expect(backToFirstPage).not.toContain("## Debug");
  });

  it("help component reaches end in narrow viewport", () => {
    const component = createGsdHelpComponent(() => {});
    const width = 40;
    let previous = "";
    let current = component.render(width).join("\n");

    while (current !== previous) {
      previous = current;
      component.handleInput?.("\u001b[6~");
      current = component.render(width).join("\n");
    }

    expect(current).toContain("## Phase Override");
    expect(current).toContain("- equals flag: `/gsd next");
    expect(current).toMatch(/\[\d+-\d+\/\d+\]/u);
  });

  it("status command renders live status panel in UI mode", async () => {
    let rendered = "";
    setGsdSubagentSdkFactoryForTests(
      () =>
        ({
          list: () => [
            {
              sessionId: "child-1",
              sessionPath: "/tmp/child-1.jsonl",
              name: "gsd-planner",
              task: "plan phase",
              status: "running",
              startedAt: Date.now() - 65_000,
              activity: { label: "planning", detail: "Reviewing roadmap and current plan gaps" },
            },
          ],
        }) as never,
    );
    await handleGsdStatus({} as never, {
      cwd: createRoot(),
      hasUI: true,
      ui: {
        notify() {},
        async custom(custom: Parameters<typeof renderCustomComponent>[0]) {
          rendered = await renderCustomComponent(custom);
        },
      },
    });

    expect(rendered).toContain("GSD Subagent Status");
    expect(rendered).toContain("1 total · 1 running");
    expect(rendered).toContain("gsd-planner · planning");
    expect(rendered).toContain("Reviewing roadmap and current plan gaps");
    expect(rendered).toContain("Esc/q close • auto-refreshing live");
  });

  it("status command UI renders cancelled label and truncated detail", async () => {
    let rendered = "";
    setGsdSubagentSdkFactoryForTests(
      () =>
        ({
          list: () => [
            {
              sessionId: "child-1",
              sessionPath: "/tmp/child-1.jsonl",
              name: "gsd-reviewer",
              task: "review phase",
              status: "cancelled",
              startedAt: Date.now() - 3_000,
              activity: {
                detail:
                  "Cancelled after a very long detail message that should be truncated before it can overwhelm the live panel output with too much content",
              },
            },
          ],
        }) as never,
    );
    await handleGsdStatus({} as never, {
      cwd: createRoot(),
      hasUI: true,
      ui: {
        notify() {},
        async custom(custom: Parameters<typeof renderCustomComponent>[0]) {
          rendered = await renderCustomComponent(custom);
        },
      },
    });

    expect(rendered).toContain("1 total · 1 done");
    expect(rendered).toContain("gsd-reviewer · cancelled · 0:03 · Cancelled after");
    expect(rendered).toContain("…");
  });

  it("status command UI ignores non-GSD child sessions", async () => {
    let rendered = "";
    setGsdSubagentSdkFactoryForTests(
      () =>
        ({
          list: () => [
            {
              sessionId: "child-1",
              sessionPath: "/tmp/child-1.jsonl",
              name: "worker",
              task: "generic detached task",
              status: "running",
              startedAt: Date.now() - 12_000,
              activity: { label: "working", detail: "Should stay out of /gsd status" },
            },
            {
              sessionId: "child-2",
              sessionPath: "/tmp/child-2.jsonl",
              name: "intel-updater:full-refresh",
              task: "refresh intel",
              status: "running",
              startedAt: Date.now() - 4_000,
              activity: { label: "refreshing", detail: "Updating intel snapshot" },
            },
          ],
        }) as never,
    );
    await handleGsdStatus({} as never, {
      cwd: createRoot(),
      hasUI: true,
      ui: {
        notify() {},
        async custom(custom: Parameters<typeof renderCustomComponent>[0]) {
          rendered = await renderCustomComponent(custom);
        },
      },
    });

    expect(rendered).toContain("1 total · 1 running");
    expect(rendered).toContain(
      "intel-updater:full-refresh · refreshing · 0:04 · Updating intel snapshot",
    );
    expect(rendered).not.toContain("worker");
    expect(rendered).not.toContain("Should stay out of /gsd status");
  });

  it("status command UI breaks equal start-time ties deterministically", async () => {
    let rendered = "";
    const startedAt = Date.now() - 5_000;
    setGsdSubagentSdkFactoryForTests(
      () =>
        ({
          list: () => [
            {
              sessionId: "child-b",
              sessionPath: "/tmp/child-b.jsonl",
              name: "gsd-reviewer",
              task: "review phase",
              status: "running",
              startedAt,
              activity: { label: "reviewing", detail: "Second by name" },
            },
            {
              sessionId: "child-a",
              sessionPath: "/tmp/child-a.jsonl",
              name: "gsd-planner",
              task: "plan phase",
              status: "running",
              startedAt,
              activity: { label: "planning", detail: "First by name" },
            },
          ],
        }) as never,
    );
    await handleGsdStatus({} as never, {
      cwd: createRoot(),
      hasUI: true,
      ui: {
        notify() {},
        async custom(custom: Parameters<typeof renderCustomComponent>[0]) {
          rendered = await renderCustomComponent(custom);
        },
      },
    });

    expect(rendered.indexOf("gsd-planner · planning · 0:05 · First by name")).toBeLessThan(
      rendered.indexOf("gsd-reviewer · reviewing · 0:05 · Second by name"),
    );
  });

  it("status command UI counts idle subagents explicitly", async () => {
    let rendered = "";
    setGsdSubagentSdkFactoryForTests(
      () =>
        ({
          list: () => [
            {
              sessionId: "child-1",
              sessionPath: "/tmp/child-1.jsonl",
              name: "gsd-planner",
              task: "plan phase",
              status: "idle",
              startedAt: Date.now() - 6_000,
              activity: { label: "idle", detail: "Waiting for follow-up input" },
            },
          ],
        }) as never,
    );
    await handleGsdStatus({} as never, {
      cwd: createRoot(),
      hasUI: true,
      ui: {
        notify() {},
        async custom(custom: Parameters<typeof renderCustomComponent>[0]) {
          rendered = await renderCustomComponent(custom);
        },
      },
    });

    expect(rendered).toContain("1 total · 1 idle");
    expect(rendered).toContain("gsd-planner · idle · 0:06 · Waiting for follow-up input");
  });
});
