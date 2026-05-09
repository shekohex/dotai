import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/extensions/gsd/state/health.js", () => ({
  computeHealth: vi.fn(() => {
    throw new Error("bundled health should not run");
  }),
  computeLocalHealthSummary: vi.fn(() => ({
    status: "degraded",
    healthy: true,
    issues: [{ severity: "warning", code: "WLOCAL", message: "local summary" }],
  })),
}));

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { getGsdSubcommandHint } from "../../src/extensions/gsd/state/suggestions.js";
import { showGsdDashboard } from "../../src/extensions/gsd/ui.js";

initTheme("dark");

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-gsd-health-summary-"));
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
    "# Roadmap: Demo\n\n### Phase 1: Foundation\n**Goal**: Build base\n\nPlans:\n- [ ] 01-01: Create base\n",
  );
  writeFileSync(
    join(root, ".planning", "phases", "1-foundation", "01-01-PLAN.md"),
    "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/index.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
  );
  writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
  writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
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

describe("gsd local health summary paths", () => {
  it("autocomplete health hint uses local summary instead of bundled validator", () => {
    expect(getGsdSubcommandHint(createRoot(), "health")).toBe("degraded • 1 issues");
  });

  it("dashboard refresh uses local summary instead of bundled validator", async () => {
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
    expect(rendered).toContain("Health: degraded • 1 issues");
  });
});
