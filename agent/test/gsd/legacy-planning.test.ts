import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNextRoute } from "../../src/extensions/gsd/instant/next.js";
import { computeStructuredStats } from "../../src/extensions/gsd/state/stats.js";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

function createPlanningRoot(): string {
  const root = createTempDirSync("agent-gsd-legacy-planning-");
  mkdirSync(join(root, ".planning", "phases"), { recursive: true });
  writeFileSync(
    join(root, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
  );
  writeFileSync(join(root, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
  return root;
}

describe("GSD legacy planning compatibility", () => {
  it("routes completed filename-style roadmap to milestone closeout", () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap

## Phase Details

### Phase 21: Extraction and Storybook Parity
**Goal**: Extract auth system
**Plans**: 2 plans

Plans:
- [x] 21-01-PLAN.md — Freeze route ledger.
- [x] 21-02-PLAN.md — Publish auth Storybook primitives.

### Phase 22: Auth Route Migration and Signoff
**Goal**: Migrate auth routes
**Plans**: 2 plans

Plans:
- [x] 22-00-PLAN.md — Create verification ledger.
- [x] 22-01-PLAN.md — Migrate sign-in.
`,
    );
    const phase21Dir = join(root, ".planning", "phases", "21-extraction-and-storybook-parity");
    const phase22Dir = join(root, ".planning", "phases", "22-auth-route-migration-and-signoff");
    mkdirSync(phase21Dir, { recursive: true });
    mkdirSync(phase22Dir, { recursive: true });
    for (const planId of ["21-01", "21-02", "22-00", "22-01"]) {
      const phase = planId.startsWith("21") ? "21" : "22";
      const phaseDir = phase === "21" ? phase21Dir : phase22Dir;
      const plan = planId.split("-")[1] ?? "01";
      writeFileSync(join(phaseDir, `${planId}-PLAN.md`), buildPlan(phase, plan));
      writeFileSync(join(phaseDir, `${planId}-SUMMARY.md`), "# summary\n");
    }
    writeFileSync(join(phase21Dir, "21-VERIFICATION.md"), "---\nstatus: passed\n---\n");
    writeFileSync(join(phase22Dir, "22-VERIFICATION.md"), "---\nstatus: ready_for_closeout\n---\n");

    expect(resolveNextRoute(root)).toMatchObject({ route: "complete-milestone" });
    expect(computeStructuredStats(root)).toMatchObject({
      phases_completed: 2,
      total_plans: 4,
      total_summaries: 4,
      percent: 100,
    });
  });

  it("preserves rich legacy plans with fallback frontmatter parsing", () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap

### Phase 1: Legacy
**Plans**: 1 plan

Plans:
- [x] 01-01-PLAN.md — Legacy plan.
`,
    );
    const phaseDir = join(root, ".planning", "phases", "1-legacy");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(
      join(phaseDir, "01-01-PLAN.md"),
      `---
phase: 1-legacy
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified: []
autonomous: true
must_haves:
  artifacts:
    - path: src/example.ts
      contains: "legacy"
  key_links:
    - from: a
      to: b
      via: \`legacy plain scalar\`
---

<objective>Legacy plan</objective>
`,
    );
    writeFileSync(join(phaseDir, "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(join(phaseDir, "01-VERIFICATION.md"), "---\nstatus: passed\n---\n");

    expect(resolveNextRoute(root)).toMatchObject({ route: "complete-milestone" });
  });

  it("does not count stray summary filenames as completed roadmap plans", () => {
    const root = createPlanningRoot();
    const phaseDir = join(root, ".planning", "phases", "1-setup");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(root, ".planning", "ROADMAP.md"), roadmapWithOneUncheckedPlan());
    writeFileSync(join(phaseDir, "01-01-PLAN.md"), "# plan\n");
    writeFileSync(join(phaseDir, "backup-01-01-SUMMARY.md"), "# stale backup\n");

    expect(resolveNextRoute(root)).toMatchObject({ route: "execute-phase", newPhase: "1" });
  });

  it("does not route verified local completion back to verify when roadmap checkbox is stale", () => {
    const root = createPlanningRoot();
    const phaseDir = join(root, ".planning", "phases", "1-setup");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(root, ".planning", "ROADMAP.md"), roadmapWithOneUncheckedPlan());
    writeFileSync(join(phaseDir, "01-01-PLAN.md"), "# plan\n");
    writeFileSync(join(phaseDir, "01-01-SUMMARY.md"), "# summary\n");
    writeFileSync(join(phaseDir, "01-VERIFICATION.md"), "---\nstatus: passed\n---\n");

    expect(resolveNextRoute(root)).toMatchObject({ route: "complete-milestone" });
  });

  it("does not let stale noncanonical verification skip required verify-work before state phase", () => {
    const root = createPlanningRoot();
    writeFileSync(join(root, ".planning", "STATE.md"), "current_phase: 2\nstatus: Ready\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap

### Phase 1: Setup
**Plans**: 1 plan

Plans:
- [x] 1-01: Setup

### Phase 2: Delivery
**Plans**: 1 plan

Plans:
- [ ] 2-01: Ship
`,
    );
    const phase1Dir = join(root, ".planning", "phases", "1-setup");
    const phase2Dir = join(root, ".planning", "phases", "2-delivery");
    mkdirSync(phase1Dir, { recursive: true });
    mkdirSync(phase2Dir, { recursive: true });
    writeFileSync(join(phase1Dir, "1-01-PLAN.md"), buildPlan("1", "01"));
    writeFileSync(join(phase1Dir, "1-01-SUMMARY.md"), "# summary\n");
    writeFileSync(join(phase1Dir, "99-VERIFICATION.md"), "---\nstatus: passed\n---\n");
    writeFileSync(join(phase2Dir, "2-01-PLAN.md"), buildPlan("2", "01"));

    expect(resolveNextRoute(root)).toMatchObject({
      route: "verify-work",
      reason: "phase ready to verify",
      newPhase: "1",
    });
  });
});

function buildPlan(phase: string, plan: string): string {
  return `---
phase: ${phase}
plan: ${plan}
type: implementation
wave: 1
depends_on: []
files_modified: []
autonomous: true
must_haves: [done]
---
`;
}

function roadmapWithOneUncheckedPlan(): string {
  return `# Roadmap

### Phase 1: Setup
**Goal**: Establish baseline
**Plans**: 1 plan

Plans:
- [ ] 01-01-PLAN.md — Create config
`;
}
