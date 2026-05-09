import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeNext,
  handleGsdNext,
  resolveNextRoute,
} from "../../src/extensions/gsd/instant/next.js";
import { readRoadmapPhases } from "../../src/extensions/gsd/state/roadmap.js";
import { resolveCurrentPhase } from "../../src/extensions/gsd/state/runtime.js";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

function createPlanningRoot(): string {
  const root = createTempDirSync("agent-gsd-roadmap-");
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

## Phase Details

### Phase 1: Setup
**Goal**: Establish project baseline
**Depends on**: Nothing
**Requirements**: [REQ-01, REQ-02]
**Success Criteria** (what must be TRUE):
  1. Repo bootstraps
  2. Tests run
**Plans**: 2 plans

Plans:
- [ ] 01-01: Create config
- [x] 01-02: Add tests

### Phase 2: Build
**Goal**: Ship feature
**Depends on**: Phase 1
**Requirements**: [REQ-03]
**Success Criteria** (what must be TRUE):
  1. Feature works
**Plans**: 1 plan

Plans:
- [ ] 02-01: Implement feature
`,
  );
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: 01-01\nstatus: Ready to execute\n",
  );
  return root;
}

describe("roadmap parser", () => {
  it("parses phases and plan list", () => {
    const root = createPlanningRoot();
    const phases = readRoadmapPhases(root);
    expect(phases).toHaveLength(2);
    expect(phases[0]?.number).toBe("1");
    expect(phases[0]?.requirements).toEqual(["REQ-01", "REQ-02"]);
    expect(phases[0]?.plans[1]?.completed).toBe(true);
  });

  it("resolves current phase from state", () => {
    const root = createPlanningRoot();
    const current = resolveCurrentPhase(root);
    expect(current?.phase.number).toBe("1");
    expect(current?.phase.name).toBe("Setup");
    expect(current?.phaseDir.endsWith("/.planning/phases/1-setup")).toBe(true);
  });

  it("advances next plan from phase plans", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    const result = computeNext(root);
    expect(result.advanced).toBe(true);
    expect(result.currentPlan).toBe("01-02");
  });

  it("advances to next phase when current phase plans are complete", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-01-PLAN.md"),
      "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/c.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    const result = computeNext(root);
    expect(result.reason).toBe("phase-advanced");
    expect(result.newPhase).toBe("2");
    expect(result.currentPlan).toBe("02-01");
  });

  it("prefers earliest incomplete phase when state drifted ahead", () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 2\ncurrent_phase_name: Build\ncurrent_plan: 02-01\nstatus: Ready to execute\n",
    );
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-01-PLAN.md"),
      "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/c.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );

    const result = computeNext(root);
    expect(result.reason).toBe("phase-ready");
    expect(result.newPhase).toBe("1");
    expect(result.currentPlan).toBe("01-01");
  });

  it("fallback next handling fails closed when earliest incomplete phase needs workflow routing", () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 2\ncurrent_phase_name: Build\ncurrent_plan: 02-01\nstatus: Ready to execute\n",
    );
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-01-PLAN.md"),
      "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/c.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    const notifications: Array<{ message: string; level: string }> = [];

    handleGsdNext(
      {} as never,
      {
        cwd: root,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      } as never,
    );

    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    expect(state).toContain("current_phase: 2");
    expect(state).toContain("current_phase_name: Build");
    expect(state).toContain("current_plan: 02-01");
    expect(notifications.at(-1)).toEqual({
      message:
        "Next requires workflow session for /gsd execute-phase 1. Cannot safely fall back to pointer-only state updates.",
      level: "warning",
    });
  });

  it("fails closed instead of updating state when next across phases needs workflow routing", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-01-PLAN.md"),
      "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/c.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    const notifications: Array<{ message: string; level: string }> = [];
    handleGsdNext(
      {} as never,
      {
        cwd: root,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      } as never,
    );
    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    expect(state).toContain("current_phase: 1");
    expect(state).toContain("current_phase_name: Setup");
    expect(state).toContain("current_plan: 01-01");
    expect(notifications.at(-1)).toEqual({
      message:
        "Next requires workflow session for /gsd verify-work 1. Cannot safely fall back to pointer-only state updates.",
      level: "warning",
    });
  });

  it("preserves brownfield state body when next fails closed", () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      [
        "current_phase: 1",
        "current_phase_name: Setup",
        "current_plan: 01-01",
        "status: Ready to execute",
        "",
        "**Project:** Brownfield Demo",
        "",
        "milestone: v1",
      ].join("\n"),
    );
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "# summary\n");
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-01-PLAN.md"),
      "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/c.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    handleGsdNext(
      {} as never,
      {
        cwd: root,
        ui: {
          notify() {},
        },
      } as never,
    );
    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    expect(state).toContain("current_phase: 1");
    expect(state).toContain("current_phase_name: Setup");
    expect(state).toContain("current_plan: 01-01");
    expect(state).toContain("status: Ready to execute");
    expect(state).toContain("**Project:** Brownfield Demo");
    expect(state).toContain("milestone: v1");
  });

  it("parses and resolves inserted decimal phases in place", () => {
    const root = createTempDirSync("agent-gsd-roadmap-decimal-");
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

### Phase 2: Build
**Goal**: Ship feature

Plans:
- [x] 02-01: Implement feature

### Phase 2.1: Hotfix (INSERTED)
**Goal**: Fix urgent regression

Plans:
- [ ] 2.1-01: Patch regression
`,
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 2.1\ncurrent_phase_name: Hotfix\ncurrent_plan: \nstatus: Ready to execute\n",
    );
    mkdirSync(join(root, ".planning", "phases", "2.1-hotfix"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "2.1-hotfix", "2.1-01-PLAN.md"),
      "---\nphase: 2.1\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/hotfix.ts]\nautonomous: true\nmust_haves: [fixed]\n---\n",
    );

    const phases = readRoadmapPhases(root);
    expect(phases.map((phase) => phase.number)).toEqual(["2", "2.1"]);
    const current = resolveCurrentPhase(root);
    expect(current?.phase.number).toBe("2.1");
    expect(current?.phaseDir.endsWith("/.planning/phases/2.1-hotfix")).toBe(true);
    const next = computeNext(root);
    expect(next.currentPlan).toBe("2.1-01");
    expect(next.newPhase).toBe("2.1");
  });

  it("parses milestone-grouped roadmap phase headings with level four markdown headers", () => {
    const root = createTempDirSync("agent-gsd-roadmap-milestone-");
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

## Milestones

- ✅ **v1.0 MVP** - Phases 1-4 (shipped 2026-05-04)
- 🚧 **v1.1 Security** - Phases 5-6 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-4) - SHIPPED 2026-05-04</summary>

### Phase 1: Foundation
**Goal**: Already shipped

Plans:
- [x] 01-01: Done

</details>

### 🚧 v1.1 Security (In Progress)

**Milestone Goal:** Tighten auth

#### Phase 5: Security
**Goal**: Secure auth

Plans:
- [ ] 05-01: Lock auth
`,
    );

    const phases = readRoadmapPhases(root);
    expect(phases.map((phase) => phase.number)).toEqual(["1", "5"]);
    expect(phases[1]?.name).toBe("Security");
    expect(phases[1]?.plans[0]?.id).toBe("05-01");
  });

  it("routes legacy verification-only phase to verify-work until authoritative UAT completes", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"),
      "# verification\n",
    );
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-01-PLAN.md"),
      "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/c.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );

    expect(resolveNextRoute(root)).toMatchObject({
      route: "verify-work",
      reason: "phase ready to verify",
      newPhase: "1",
    });

    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-UAT.md"),
      "---\nstatus: complete\n---\n\n# UAT\n",
    );

    expect(resolveNextRoute(root)).toMatchObject({
      route: "execute-phase",
      newPhase: "2",
    });
  });

  it("blocks next when planning root continue-here has blocking rows", () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", ".continue-here.md"),
      [
        "# Resume",
        "",
        "| Requirement | Status | Blocking Issue |",
        "| --- | --- | --- |",
        "| Auth | pending | waiting on checkpoint |",
      ].join("\n"),
    );

    expect(resolveNextRoute(root)).toEqual({
      advanced: false,
      reason: "blocked by .continue-here.md; resume pending work before /gsd next",
    });
  });

  it("blocks next when paused state is recorded", () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: 01-01\nstatus: Paused for review\npaused_at: 2026-05-08T12:00:00Z\n",
    );

    expect(resolveNextRoute(root)).toEqual({
      advanced: false,
      reason: "blocked by paused state at 2026-05-08T12:00:00Z",
    });
  });

  it("blocks next when discuss checkpoint is active", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "DISCUSS-CHECKPOINT.json"),
      JSON.stringify({ phase: "1" }),
    );

    expect(resolveNextRoute(root)).toEqual({
      advanced: false,
      reason: "blocked by discuss checkpoint in phase 1; resume with /gsd discuss-phase 1",
    });
  });

  it("blocks next when discuss checkpoint exists in brownfield phase dir with slug drift", () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

## Phase Details

### Phase 1: Renamed Setup
**Goal**: Establish project baseline

Plans:
- [ ] 01-01: Create config

### Phase 2: Build
**Goal**: Ship feature

Plans:
- [ ] 02-01: Implement feature
`,
    );
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "DISCUSS-CHECKPOINT.json"),
      JSON.stringify({ phase: "1" }),
    );

    expect(resolveNextRoute(root)).toEqual({
      advanced: false,
      reason: "blocked by discuss checkpoint in phase 1; resume with /gsd discuss-phase 1",
    });
  });

  it("blocks next when discuss checkpoint exists in zero-padded brownfield phase dir", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "01-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "01-setup", "DISCUSS-CHECKPOINT.json"),
      JSON.stringify({ phase: "01" }),
    );

    expect(resolveNextRoute(root)).toEqual({
      advanced: false,
      reason: "blocked by discuss checkpoint in phase 1; resume with /gsd discuss-phase 1",
    });
  });

  it("routes verified advance with missing phase prep through discuss-phase", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-UAT.md"),
      "---\nstatus: complete\n---\n\n# UAT\n",
    );

    expect(resolveNextRoute(root)).toMatchObject({
      route: "discuss-phase",
      reason: "phase discuss context missing",
      newPhase: "2",
    });
  });

  it("routes successful discuss advance to plan-phase without requiring research artifact", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-UAT.md"),
      "---\nstatus: complete\n---\n\n# UAT\n",
    );
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"), "# CONTEXT\n");

    expect(resolveNextRoute(root)).toMatchObject({
      route: "plan-phase",
      reason: "missing plan artifacts",
      newPhase: "2",
    });
  });

  it("routes discuss prep through zero-padded local phase dir context", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-UAT.md"),
      "---\nstatus: complete\n---\n\n# UAT\n",
    );
    mkdirSync(join(root, ".planning", "phases", "02-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "02-build", "02-CONTEXT.md"), "# CONTEXT\n");

    expect(resolveNextRoute(root)).toMatchObject({
      route: "plan-phase",
      reason: "missing plan artifacts",
      newPhase: "2",
    });
  });

  it("blocks next when latest verification failed and no complete UAT resolved it", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"),
      "---\nverified: false\n---\n\n# Verification\n",
    );

    expect(resolveNextRoute(root)).toEqual({
      advanced: false,
      reason: "blocked by unresolved verification FAIL in phase 1; rerun /gsd verify-work 1",
    });
  });

  it("blocks next when verification failed in zero-padded brownfield phase dir", () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "01-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "01-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "01-setup", "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "01-setup", "01-02-PLAN.md"),
      "---\nphase: 01\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "01-setup", "01-02-SUMMARY.md"), "# summary\n");
    writeFileSync(
      join(root, ".planning", "phases", "01-setup", "01-VERIFICATION.md"),
      "---\nverified: false\n---\n\n# Verification\n",
    );

    expect(resolveNextRoute(root)).toEqual({
      advanced: false,
      reason: "blocked by unresolved verification FAIL in phase 1; rerun /gsd verify-work 1",
    });
  });
});
