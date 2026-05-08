import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeHealth, computeLocalHealthSummary } from "../../src/extensions/gsd/state/health.js";
import { computeProgress } from "../../src/extensions/gsd/state/progress.js";
import { readPlanningSnapshot } from "../../src/extensions/gsd/state/read.js";
import { readRoadmapPhases } from "../../src/extensions/gsd/state/roadmap.js";
import { computeStats } from "../../src/extensions/gsd/state/stats.js";
import { detectExistingPlanning } from "../../src/extensions/gsd/state/detect.js";

const fixtures = join(import.meta.dirname, "fixtures");
const brownfieldRoot = join(fixtures, "brownfield-v1");

describe("brownfield continuation", () => {
  it("detects valid brownfield project", () => {
    const result = detectExistingPlanning(brownfieldRoot);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.projectName).toBe("Brownfield Demo");
      expect(result.phaseCount).toBe(2);
    }
  });

  it("computes progress from existing .planning files", () => {
    const result = computeProgress(brownfieldRoot);
    expect(result.currentPhase).toBe("1");
    expect(result.currentPhaseName).toBe("Setup");
    expect(result.currentPlan).toBe("01-02");
    expect(result.totalPhases).toBe(2);
    expect(result.totalPlansInPhase).toBe(2);
    expect(result.completedPlans).toBe(1);
    expect(result.percent).toBe(33);
  });

  it("counts roadmap-only completed plans in mixed brownfield progress", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-progress-mixed-"));
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 1: Setup
**Goal**: Done already

Plans:
- [x] 01-01: Create config
- [x] 01-02: Add tests

### Phase 2: Build
**Goal**: In progress

Plans:
- [ ] 02-01: Ship feature
`,
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 2\ncurrent_phase_name: Build\ncurrent_plan: 02-01\nstatus: Ready to execute\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-01-PLAN.md"),
      "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/c.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );

    const result = computeProgress(root);
    expect(result.completedPlans).toBe(2);
    expect(result.percent).toBe(67);
  });

  it("unions completed plan ids across roadmap and snapshot sources within phase", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-progress-union-"));
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 2: Build
**Goal**: In progress

Plans:
- [x] 02-01: Ship feature
- [ ] 02-02: Add docs
`,
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 2\ncurrent_phase_name: Build\ncurrent_plan: 02-02\nstatus: Ready to execute\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-02-PLAN.md"),
      "---\nphase: 02\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/docs.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-02-SUMMARY.md"), "# Summary\n");

    const result = computeProgress(root);
    expect(result.completedPlans).toBe(2);
    expect(result.percent).toBe(100);
  });

  it("treats padded snapshot phase ids and unpadded roadmap phase numbers as same phase", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-progress-padded-phase-"));
    mkdirSync(join(root, ".planning", "phases", "01-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 1: Setup
**Goal**: In progress

Plans:
- [x] 01-01: Create config
`,
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: 01-01\nstatus: Ready to execute\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "01-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "01-setup", "01-01-SUMMARY.md"), "# Summary\n");

    const result = computeProgress(root);
    expect(result.totalPhases).toBe(1);
    expect(result.completedPlans).toBe(1);
    expect(result.percent).toBe(100);
  });

  it("computes stats from existing .planning files", () => {
    const result = computeStats(brownfieldRoot);
    expect(result.phaseCount).toBe(2);
    expect(result.planCount).toBe(3);
    expect(result.summaryCount).toBe(1);
    expect(result.verificationCount).toBe(0);
    expect(result.decisionsCount).toBe(2);
  });

  it("counts verification artifacts from phase snapshots", () => {
    const root = join(fixtures, "verification-only");
    const result = computeStats(root);
    expect(result.verificationCount).toBe(1);
  });

  it("reports brownfield health without errors", () => {
    const result = computeHealth(brownfieldRoot);
    expect(result.healthy).toBe(true);
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(false);
    expect(result.status).toBe("degraded");
    expect(result.issues.some((issue) => issue.severity === "warning")).toBe(true);
  });

  it("reads existing plan files in place", () => {
    const plan = readFileSync(
      join(brownfieldRoot, ".planning", "phases", "1-setup", "01-02-PLAN.md"),
      "utf8",
    );
    expect(plan).toContain("must_haves: [tests pass]");
    const snapshot = readPlanningSnapshot(brownfieldRoot);
    expect(snapshot.phases[0]?.plans[1]?.tasks).toEqual([]);
  });

  it("loads upstream-style state frontmatter with blank current_plan and nested yaml", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-state-yaml-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Project\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      [
        "---",
        "gsd_state_version: 1.0",
        "milestone: v2.0",
        "milestone_name: Platform",
        "current_phase: 4.5",
        "current_phase_name: Stabilization",
        "current_plan:",
        "status: in_progress",
        "progress:",
        "  total_phases: 17",
        "  completed_phases: 10",
        "  percent: 59",
        "---",
        "",
        "# Project State",
      ].join("\n"),
    );

    const state = readPlanningSnapshot(root).state;
    expect(state?.current_plan).toBe("");
    expect(state?.current_phase).toBe("4.5");
    expect(state?.progress).toEqual({
      total_phases: 17,
      completed_phases: 10,
      percent: 59,
    });
  });

  it("loads upstream-style nested plan frontmatter without invalid frontmatter errors", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-plan-yaml-"));
    mkdirSync(join(root, ".planning", "phases", "4.5-stabilization"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Project\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      [
        "---",
        "current_phase: 4.5",
        "current_phase_name: Stabilization",
        "current_plan: 4.5-01",
        "status: Ready to execute",
        "---",
      ].join("\n"),
    );
    writeFileSync(
      join(root, ".planning", "phases", "4.5-stabilization", "4.5-01-PLAN.md"),
      [
        "---",
        "phase: 4.5",
        "plan: 01",
        "type: execute",
        "wave: 1",
        'depends_on: ["04-03"]',
        "files_modified:",
        "  - src/runtime.ts",
        "  - src/state.ts",
        "autonomous: true",
        "requirements:",
        "  - REQ-401",
        "user_setup: []",
        "must_haves:",
        "  truths:",
        "    - CLI reads brownfield state",
        "  artifacts:",
        "    - .planning/STATE.md",
        "  key_links:",
        "    - state parser keeps blank current_plan",
        "---",
        "",
        "# Plan 4.5-01",
      ].join("\n"),
    );

    const snapshot = readPlanningSnapshot(root);
    expect(snapshot.phases[0]?.plans[0]?.frontmatter.files_modified).toEqual([
      "src/runtime.ts",
      "src/state.ts",
    ]);
    expect(snapshot.phases[0]?.plans[0]?.frontmatter.must_haves).toEqual({
      truths: ["CLI reads brownfield state"],
      artifacts: [".planning/STATE.md"],
      key_links: ["state parser keeps blank current_plan"],
    });
  });

  it("rejects missing .planning", () => {
    const result = detectExistingPlanning(join(fixtures, "missing"));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("no .planning");
    }
  });

  it("reads pending todo files from brownfield-compatible planning tree", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-todos-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    mkdirSync(join(root, ".planning", "todos", "pending"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to plan\n");
    writeFileSync(join(root, ".planning", "todos", "pending", "20260504-auth.md"), "auth\n");
    writeFileSync(join(root, ".planning", "todos", "pending", "20260504-ui.md"), "ui\n");

    const snapshot = readPlanningSnapshot(root);
    expect(snapshot.pendingTodos).toEqual(["20260504-auth.md", "20260504-ui.md"]);
  });

  it("reads milestone artifacts from planning tree", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-milestones-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    mkdirSync(join(root, ".planning", "milestones", "v1.0-mvp"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "milestone: v1.0\nstatus: Ready to plan\n");
    writeFileSync(join(root, ".planning", "milestones", "v1.0-mvp", "SUMMARY.md"), "# done\n");
    writeFileSync(join(root, ".planning", "milestones", "v1.1-security.md"), "# next\n");

    const snapshot = readPlanningSnapshot(root);
    expect(snapshot.milestones).toEqual(["v1.0-mvp", "v1.1-security.md"]);
  });

  it("reads goal artifacts from planning tree", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-goals-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    mkdirSync(join(root, ".planning", "goals", "active"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to plan\n");
    writeFileSync(join(root, ".planning", "goals", "active", "README.md"), "# active\n");
    writeFileSync(join(root, ".planning", "goals", "v1.0-launch.md"), "# launch\n");

    const snapshot = readPlanningSnapshot(root);
    expect(snapshot.goals).toEqual(["active", "v1.0-launch.md"]);
  });

  it("extracts structured task titles from plan bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-plan-tasks-"));
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-foundation", "01-01-PLAN.md"),
      [
        "---",
        "phase: 01",
        "plan: 01",
        "type: implementation",
        "wave: 1",
        "depends_on: []",
        "files_modified: [src/index.ts]",
        "autonomous: true",
        "must_haves: [works]",
        "---",
        "",
        "# Plan 01-01",
        "",
        "## Tasks",
        "",
        "### Task 1: Build base",
        "",
        "### Task 2: Verify behavior",
        "",
      ].join("\n"),
    );

    const snapshot = readPlanningSnapshot(root);
    expect(snapshot.phases[0]?.plans[0]?.tasks).toEqual(["Build base", "Verify behavior"]);
  });

  it("falls back to roadmap phases when phase directories do not exist yet", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-roadmap-only-"));
    mkdirSync(join(root, ".planning"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 1: Foundation
**Goal**: Build base

Plans:
- [ ] 01-01: Create base
- [ ] 01-02: Add tests

### Phase 2: Delivery
**Goal**: Ship feature

Plans:
- [ ] 02-01: Ship feature
`,
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: \nstatus: Ready to plan\n",
    );

    expect(readRoadmapPhases(root)).toHaveLength(2);
    const detected = detectExistingPlanning(root);
    expect(detected.valid).toBe(true);
    if (detected.valid) {
      expect(detected.phaseCount).toBe(2);
    }

    const progress = computeProgress(root);
    expect(progress.totalPhases).toBe(2);
    expect(progress.totalPlansInPhase).toBe(2);
    expect(progress.currentPhase).toBe("1");
    expect(progress.currentPhaseName).toBe("Foundation");

    const stats = computeStats(root);
    expect(stats.phaseCount).toBe(2);
    expect(stats.planCount).toBe(3);
  });

  it("treats missing PROJECT.md as unhealthy", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-health-project-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to plan\n");

    const result = computeHealth(root);
    expect(result.healthy).toBe(false);
    expect(result.status).toBe("broken");
    expect(
      result.issues.some(
        (issue) => issue.severity === "error" && issue.message === "PROJECT.md not found",
      ),
    ).toBe(true);
  });

  it("local summary survives malformed config without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-local-health-malformed-config-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{bad json\n");
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Project\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to plan\n");

    expect(() => computeLocalHealthSummary(root)).not.toThrow();
    expect(computeLocalHealthSummary(root)).toMatchObject({
      status: "degraded",
      healthy: true,
    });
    expect(computeLocalHealthSummary(root).issues).toContainEqual({
      severity: "warning",
      code: "WLOCAL_CONFIG",
      message: "config.json malformed",
    });
  });

  it("local summary keeps empty valid planning degraded instead of broken", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-local-health-empty-phases-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Project\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to plan\n");

    const result = computeLocalHealthSummary(root);
    expect(result).toMatchObject({ status: "degraded", healthy: true });
    expect(result.issues).toContainEqual({
      severity: "warning",
      code: "WLOCAL_PHASES",
      message: "No phases found",
    });
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(false);
  });
});
