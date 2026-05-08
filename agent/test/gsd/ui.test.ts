import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initTheme, type Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import {
  createGsdHelpComponent,
  getGsdHelpReference,
  showGsdHelp,
} from "../../src/extensions/gsd/help.js";
import { showGsdDashboard } from "../../src/extensions/gsd/ui.js";

initTheme("dark");

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-gsd-ui-"));
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

function createTheme(): Theme {
  return {
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

  it("help custom ui renders canonical command reference", async () => {
    let rendered = "";
    await showGsdHelp({
      cwd: createRoot(),
      hasUI: true,
      ui: {
        notify() {},
        async custom(custom) {
          rendered = await renderCustomComponent(custom);
        },
      },
    } as never);
    const reference = getGsdHelpReference();
    expect(rendered).toContain("# GSD Command Reference");
    expect(rendered).toContain("## Milestones");
    expect(rendered).toContain("## Planning");
    expect(rendered).toContain("/gsd new-milestone");
    expect(rendered).toContain("/gsd complete-milestone");
    expect(rendered).toContain("PgUp/PgDn page");
    expect(reference).toContain("/gsd new-milestone");
    expect(reference).toContain("/gsd complete-milestone");
    expect(reference).toContain("/gsd milestone-summary");
    expect(reference).toContain("/gsd debug status <slug>");
    expect(reference).toContain("/gsd secure-phase [phase]");
    expect(reference).toContain("/gsd status");
    expect(rendered).not.toContain("Docs (");
    expect(rendered).not.toContain("overview.md");
  });

  it("help component pages through canonical reference", () => {
    const component = createGsdHelpComponent(() => {});

    const firstPage = component.render(100).join("\n");
    expect(firstPage).toContain("# GSD Command Reference");
    expect(firstPage).toContain("## Planning");
    expect(firstPage).not.toContain("## Execution");
    expect(firstPage).not.toContain("## Debug");
    expect(firstPage).not.toContain("## Instant");

    component.handleInput?.("\u001b[6~");

    const secondPage = component.render(100).join("\n");
    expect(secondPage).toContain("## Execution");
    expect(secondPage).not.toContain("## Debug");

    component.handleInput?.("\u001b[6~");

    const thirdPage = component.render(100).join("\n");
    expect(thirdPage).toContain("## Debug");
    expect(thirdPage).toContain("## Instant");
    expect(thirdPage).toContain("/gsd debug status <slug>");
    expect(thirdPage).not.toContain("/gsd status");

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
});
