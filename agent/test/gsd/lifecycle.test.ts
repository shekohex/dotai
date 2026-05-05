import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { readRoadmapPhases } from "../../src/extensions/gsd/state/roadmap.js";
import { handleGsdDiscussPhase } from "../../src/extensions/gsd/lifecycle/discuss-phase.js";
import { handleGsdMapCodebase } from "../../src/extensions/gsd/lifecycle/map-codebase.js";
import { handleGsdNewProject } from "../../src/extensions/gsd/lifecycle/new-project.js";
import { handleGsdValidatePhase } from "../../src/extensions/gsd/lifecycle/validate-phase.js";
import { handleGsdVerifyWork } from "../../src/extensions/gsd/lifecycle/verify-work.js";
import { setGsdSubagentSdkFactoryForTests } from "../../src/extensions/gsd/subagents.js";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-gsd-lifecycle-"));
}

function createPlanningRoot(): string {
  const root = createRoot();
  mkdirSync(join(root, ".planning", "phases"), { recursive: true });
  writeFileSync(
    join(root, ".planning", "config.json"),
    `${JSON.stringify(
      {
        model_profile: "balanced",
        commit_docs: true,
        parallelization: true,
        search_gitignored: false,
        brave_search: false,
        firecrawl: false,
        exa_search: false,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, ".planning", "ROADMAP.md"),
    `# Roadmap: Demo

### Phase 1: Setup
**Goal**: Establish project baseline

Plans:
- [ ] 01-01: Create config

### Phase 2: Build
**Goal**: Ship feature

Plans:
- [ ] 02-01: Implement feature
`,
  );
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: \nstatus: Ready to plan\n",
  );
  return root;
}

function createContext(cwd: string): ExtensionCommandContext {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
}

afterEach(() => {
  setGsdSubagentSdkFactoryForTests(undefined);
});

describe("gsd lifecycle handlers", () => {
  it("new-project writes baseline planning files", () => {
    const root = createRoot();
    const ctx = createContext(root);
    handleGsdNewProject({} as ExtensionAPI, ctx);
    expect(readFileSync(join(root, ".planning", "config.json"), "utf8")).toContain(
      '"model_profile": "balanced"',
    );
    expect(readFileSync(join(root, ".planning", "PROJECT.md"), "utf8")).toContain(
      root.split("/").at(-1) ?? "",
    );
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Ready to plan",
    );
  });

  it("new-project does not seed placeholder roadmap phases", () => {
    const root = createRoot();
    const ctx = createContext(root);
    handleGsdNewProject({} as ExtensionAPI, ctx);
    expect(readRoadmapPhases(root)).toEqual([]);
  });

  it("map-codebase writes research artifact and runs mapper role", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        structured: {
          summary: "Core app with tests",
          modules: [{ name: "core", purpose: "Main logic", files: ["src/index.ts"] }],
          tests: ["test/index.test.ts"],
          conventions: ["Use Vitest"],
          risks: ["No integration coverage"],
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdMapCodebase({} as ExtensionAPI, ctx);
    const outputPath = join(root, ".planning", "research", "CODEBASE_MAP.md");
    expect(readFileSync(outputPath, "utf8")).toContain("Core app with tests");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(outputPath);
    expect(spawn.mock.calls[0]?.[0]?.task).toContain("<required_reading>");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(join(root, ".planning", "PROJECT.md"));
  });

  it("discuss-phase writes phase-specific context for explicit phase", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        structured: {
          boundary: "Ship feature",
          decisions: [{ area: "Delivery", choices: ["Use existing service layer"] }],
          discretion: ["Exact function split"],
          specifics: ["Keep API small"],
          references: [{ path: "docs/feature.md", reason: "Requirements" }],
          reusable_assets: ["src/shared/api.ts"],
          patterns: ["Prefer composition"],
          integration_points: ["src/routes.ts"],
          deferred: ["Admin UI"],
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    const contextPath = join(root, ".planning", "phases", "2-build", "02-CONTEXT.md");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain("<required_reading>");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(join(root, ".planning", "ROADMAP.md"));
    expect(readFileSync(contextPath, "utf8")).toContain("# Phase 2: Build - Context");
    expect(readFileSync(contextPath, "utf8")).toContain("Use existing service layer");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "current_phase_name: Build",
    );
  });

  it("validate-phase writes validation file for explicit phase", () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    handleGsdValidatePhase({} as ExtensionAPI, ctx, { phase: "2" });
    const validationPath = join(root, ".planning", "phases", "2-build", "02-VALIDATION.md");
    expect(readFileSync(validationPath, "utf8")).toContain("Validation");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain("current_phase: 2");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Ready to validate",
    );
  });

  it("verify-work writes verification artifacts and updates state", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/config.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
    );
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        structured: {
          verified: true,
          summary: "verified",
          truths: [{ truth: "works", status: "verified", evidence: "manual check" }],
          blockers: [],
          warnings: [],
          uat_items: [{ name: "smoke", result: "pass" }],
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdVerifyWork({} as ExtensionAPI, ctx, {});
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"), "utf8"),
    ).toContain("verified");
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-VALIDATION.md"), "utf8"),
    ).toContain("Validated");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Phase complete",
    );
  });
});
