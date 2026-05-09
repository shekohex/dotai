import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleGsdHealth } from "../../src/extensions/gsd/instant/health.js";
import { handleGsdStats } from "../../src/extensions/gsd/instant/stats.js";
import { computeStructuredStats } from "../../src/extensions/gsd/state/stats.js";

const fixtures = join(import.meta.dirname, "fixtures");
const brownfieldRoot = join(fixtures, "brownfield-v1");

function createNotifications() {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ctx: {
      cwd: brownfieldRoot,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
  };
}

describe("gsd instant commands", () => {
  it("stats includes verification count", () => {
    const verificationRoot = join(fixtures, "verification-only");
    const notifications: Array<{ message: string; level: string }> = [];
    handleGsdStats(
      {} as never,
      {
        cwd: verificationRoot,
        hasUI: false,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      } as never,
    );
    expect(notifications.at(-1)).toEqual({
      message:
        "Stats milestone=current phases=1 plans=1 summaries=0 verifications=1 blockers=0 decisions=0",
      level: "info",
    });
  });

  it("stats includes blockers and decisions from brownfield state", () => {
    const { notifications, ctx } = createNotifications();
    handleGsdStats({} as never, ctx as never);
    expect(notifications.at(-1)).toEqual({
      message:
        "Stats milestone=current phases=2 plans=3 summaries=1 verifications=0 blockers=0 decisions=2",
      level: "info",
    });
  });

  it("stats scope counts to current milestone", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-milestone-"));
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "5-security"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
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
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "milestone: v1.1\ncurrent_phase: 5\ncurrent_phase_name: Security\ncurrent_plan: 05-01\nstatus: Ready to execute\n",
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "phases", "1-foundation", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "5-security", "05-01-PLAN.md"),
      "---\nphase: 05\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/auth.ts]\nautonomous: true\nmust_haves: [secure]\n---\n",
    );

    expect(computeStructuredStats(root).phases.map((phase) => phase.number)).toEqual(["5"]);

    const notifications: Array<{ message: string; level: string }> = [];
    handleGsdStats(
      {} as never,
      {
        cwd: root,
        hasUI: false,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      } as never,
    );

    expect(notifications.at(-1)).toEqual({
      message:
        "Stats milestone=v1.1 phases=1 plans=1 summaries=0 verifications=0 blockers=0 decisions=0",
      level: "info",
    });
  });

  it("stats scopes shipped milestone phases from details summary blocks", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-milestone-details-"));
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "5-security"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
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

<details>
<summary>🚧 v1.1 Security (Phases 5-6) - IN PROGRESS</summary>

#### Phase 5: Security
**Goal**: Secure auth

Plans:
- [ ] 05-01: Lock auth

</details>
`,
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 01-01\nstatus: Ready to execute\n",
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "phases", "1-foundation", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "5-security", "05-01-PLAN.md"),
      "---\nphase: 05\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/auth.ts]\nautonomous: true\nmust_haves: [secure]\n---\n",
    );

    expect(computeStructuredStats(root).phases.map((phase) => phase.number)).toEqual(["1"]);
  });

  it("stats scopes milestone labels exactly instead of partial version matches", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-milestone-exact-"));
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-release"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### 🚧 v1.0 Foundation

#### Phase 1: Foundation
**Goal**: Foundation

Plans:
- [ ] 01-01: Build base

### 🚧 v1.1 Release

#### Phase 2: Release
**Goal**: Release

Plans:
- [ ] 02-01: Ship release
`,
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "milestone: v1\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 01-01\nstatus: Ready to execute\n",
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");

    expect(computeStructuredStats(root).phases.map((phase) => phase.number)).toEqual(["1", "2"]);
  });

  it("stats json emits structured output", () => {
    const { notifications, ctx } = createNotifications();
    handleGsdStats({} as never, ctx as never, { outputMode: "json" });
    expect(JSON.parse(notifications.at(-1)?.message ?? "")).toMatchObject({
      milestone_version: "current",
      phases_total: 2,
      total_plans: 3,
      requirements_total: 3,
      requirements_complete: 0,
    });
  });

  it("stats table emits structured table output", () => {
    const { notifications, ctx } = createNotifications();
    handleGsdStats({} as never, ctx as never, { outputMode: "table" });
    expect(notifications.at(-1)).toEqual(
      expect.objectContaining({
        level: "info",
        message: expect.stringContaining("| Phase | Name | Plans | Completed | Status |"),
      }),
    );
    expect(notifications.at(-1)?.message).toContain("# current Current — Statistics");
    expect(notifications.at(-1)?.message).toContain("Requirements: 0/3 complete");
  });

  it("stats canonicalizes padded local phase ids and keeps executed work distinct from complete", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-phase-status-"));
    mkdirSync(join(root, ".planning", "phases", "01-setup"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-release"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "3-manual"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 1: Setup
**Goal**: Build setup

Plans:
- [ ] 01-01: Create config

### Phase 2: Release
**Goal**: Ship release

Plans:
- [ ] 02-01: Ship feature

### Phase 3: Manual
**Goal**: Manual verify

Plans:
- [ ] 03-01: Validate device flow
`,
    );
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(
      join(root, ".planning", "phases", "01-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/setup.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "01-setup", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-release", "02-01-PLAN.md"),
      "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/release.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "2-release", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-release", "02-UAT.md"),
      "---\nstatus: complete\n---\n\n# UAT\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "3-manual", "03-01-PLAN.md"),
      "---\nphase: 03\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/manual.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "3-manual", "03-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "3-manual", "03-VERIFICATION.md"),
      "---\nstatus: human_needed\n---\n\n# Verification\n",
    );

    expect(computeStructuredStats(root).phases).toEqual([
      expect.objectContaining({ number: "1", summaries: 1, status: "Executed" }),
      expect.objectContaining({ number: "2", summaries: 1, status: "Complete" }),
      expect.objectContaining({ number: "3", summaries: 1, status: "Human Needed" }),
    ]);
  });

  it("stats counts requirements from checklist, plain bullets, and traceability status", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-requirements-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(
      join(root, ".planning", "REQUIREMENTS.md"),
      [
        "# Requirements: Demo",
        "",
        "## v1 Requirements",
        "",
        "- [x] **AUTH-01**: Login works",
        "- AUTH-02: Logout works",
        "",
        "## v2 Requirements",
        "",
        "- BILL-01: Deferred billing",
        "",
        "## Traceability",
        "",
        "| Requirement | Phase | Status |",
        "| --- | --- | --- |",
        "| AUTH-01 | Phase 1 | Complete |",
        "| AUTH-02 | Phase 1 | Pending |",
        "| AUTH-03 | Phase 2 | Verified |",
      ].join("\n"),
    );

    expect(computeStructuredStats(root)).toMatchObject({
      requirements_total: 3,
      requirements_complete: 2,
    });
  });

  it("stats excludes deferred full semver requirement headings", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-requirements-semver-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(
      join(root, ".planning", "REQUIREMENTS.md"),
      [
        "# Requirements: Demo",
        "",
        "## v1 Requirements",
        "",
        "- API-01: Keep this",
        "",
        "## v2.0.1 Requirements",
        "",
        "- API-02: Defer this",
      ].join("\n"),
    );

    expect(computeStructuredStats(root)).toMatchObject({
      requirements_total: 1,
      requirements_complete: 0,
    });
  });

  it("stats treats v1.x requirement headings as current actionable scope", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-requirements-v1x-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(
      join(root, ".planning", "REQUIREMENTS.md"),
      [
        "# Requirements: Demo",
        "",
        "## v1.1 Requirements",
        "",
        "- [x] API-01: Keep this current",
        "",
        "## Traceability",
        "",
        "| Requirement | Phase | Status |",
        "| --- | --- | --- |",
        "| API-01 | Phase 1 | Complete |",
      ].join("\n"),
    );

    expect(computeStructuredStats(root)).toMatchObject({
      requirements_total: 1,
      requirements_complete: 1,
    });
  });

  it("stats keeps deferred requirement ids excluded when traceability repeats them", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-requirements-traceability-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(
      join(root, ".planning", "REQUIREMENTS.md"),
      [
        "# Requirements: Demo",
        "",
        "## v1 Requirements",
        "",
        "- API-01: Keep this",
        "",
        "## v2 Requirements",
        "",
        "- API-02: Defer this",
        "",
        "## Traceability",
        "",
        "| Requirement | Phase | Status |",
        "| --- | --- | --- |",
        "| API-01 | Phase 1 | Complete |",
        "| API-02 | Phase 2 | Complete |",
      ].join("\n"),
    );

    expect(computeStructuredStats(root)).toMatchObject({
      requirements_total: 1,
      requirements_complete: 1,
    });
  });

  it("stats treats verification-only local phases as started", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-stats-verification-only-status-"));
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 1: Setup
**Goal**: Verify shipped work

Plans:
- [ ] 01-01: Legacy task
`,
    );
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"),
      "---\nverified: true\n---\n\n# Verification\n",
    );

    expect(computeStructuredStats(root).phases).toEqual([
      expect.objectContaining({ number: "1", status: "In Progress", summaries: 0 }),
    ]);
  });

  it("stats rejects unsupported output variants explicitly", () => {
    const { notifications, ctx } = createNotifications();
    handleGsdStats({} as never, ctx as never, {
      unsupportedModeError: "Unsupported /gsd stats argument: yaml.",
    });
    expect(notifications.at(-1)).toEqual({
      message: "Unsupported /gsd stats argument: yaml.",
      level: "warning",
    });
  });

  it("health reports non-error brownfield drift without failure", () => {
    const { notifications, ctx } = createNotifications();
    handleGsdHealth({} as never, ctx as never);
    expect(notifications.at(-1)?.level).toBe("warning");
    expect(notifications.at(-1)?.message).toContain("Health degraded");
  });

  it("health reports missing PROJECT.md as non-green", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-health-missing-project-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to plan\n");

    const notifications: Array<{ message: string; level: string }> = [];
    handleGsdHealth(
      {} as never,
      {
        cwd: root,
        hasUI: false,
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      } as never,
    );

    expect(notifications.at(-1)?.level).toBe("warning");
    expect(notifications.at(-1)?.message).toBe(
      [
        "Health broken errors=1 warnings=1 info=0",
        "ERROR E002: PROJECT.md not found",
        "WARNING W010: No GSD agents found in " +
          `${join(import.meta.dirname, "../../src/resources/agents")} — ` +
          'Task(subagent_type="gsd-*") will fall back to general-purpose',
      ].join("\n"),
    );
  });

  it("health reports malformed config as structured output instead of crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-health-malformed-config-"));
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{bad json\n");
    writeFileSync(
      join(root, ".planning", "PROJECT.md"),
      "## What This Is\n\nDemo\n\n## Core Value\n\nValue\n\n## Requirements\n\n- One\n",
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to plan\n");

    const notifications: Array<{ message: string; level: string }> = [];
    expect(() =>
      handleGsdHealth(
        {} as never,
        {
          cwd: root,
          hasUI: false,
          ui: {
            notify(message: string, level: string) {
              notifications.push({ message, level });
            },
          },
        } as never,
      ),
    ).not.toThrow();

    expect(notifications.at(-1)?.level).toBe("warning");
    expect(notifications.at(-1)?.message).toContain("Health broken");
    expect(notifications.at(-1)?.message).toContain("errors=1");
    expect(notifications.at(-1)?.message).toContain("ERROR E005");
  });

  it("fixture state remains unchanged after instant commands", () => {
    const stateBefore = readFileSync(join(brownfieldRoot, ".planning", "STATE.md"), "utf8");
    const { ctx } = createNotifications();
    handleGsdStats({} as never, ctx as never);
    handleGsdHealth({} as never, ctx as never);
    const stateAfter = readFileSync(join(brownfieldRoot, ".planning", "STATE.md"), "utf8");
    expect(stateAfter).toBe(stateBefore);
  });
});
