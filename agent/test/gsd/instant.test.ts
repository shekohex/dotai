import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleGsdHealth } from "../../src/extensions/gsd/instant/health.js";
import { handleGsdStats } from "../../src/extensions/gsd/instant/stats.js";
import { computeStructuredStats } from "../../src/extensions/gsd/state/stats.js";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

const require = createRequire(import.meta.url);
const gsdCore = require("../../src/resources/gsd/bin/lib/core.cjs") as {
  checkAgentsInstalled: (agentsDir?: string) => {
    agents_installed: boolean;
    missing_agents: string[];
    installed_agents: string[];
    agents_dir: string;
  };
  resolveAgentsDir: (baseDir?: string) => string;
};
const gsdModelProfiles = require("../../src/resources/gsd/bin/lib/model-profiles.cjs") as {
  MODEL_PROFILES: Record<string, unknown>;
};

const fixtures = join(import.meta.dirname, "fixtures");
const brownfieldRoot = join(fixtures, "brownfield-v1");

function createNotifications() {
  return createNotificationsForRoot(brownfieldRoot);
}

function createNotificationsForRoot(cwd: string) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    notifications,
    ctx: {
      cwd,
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
    expect(notifications.at(-1)?.level).toBe("info");
    expect(notifications.at(-1)?.message).toContain("# current Current — Statistics");
    expect(notifications.at(-1)?.message).toContain("| 1 | Setup | 1 | 0 | In Progress |");
  });

  it("stats verification count excludes validation and UAT artifacts", () => {
    const root = createTempDirSync("agent-gsd-stats-verification-only-count-");
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
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
`,
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-foundation", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/index.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "1-foundation", "01-01-VERIFICATION.md"),
      "verification\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "1-foundation", "01-01-VALIDATION.md"),
      "validation\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "1-foundation", "01-UAT.md"),
      "---\nstatus: complete\n---\n\n# UAT\n",
    );

    expect(computeStructuredStats(root).verification_count).toBe(1);
  });

  it("stats includes blockers and decisions from brownfield state", () => {
    const { notifications, ctx } = createNotifications();
    handleGsdStats({} as never, ctx as never);
    expect(notifications.at(-1)?.level).toBe("info");
    expect(notifications.at(-1)?.message).toContain("# current Current — Statistics");
    expect(notifications.at(-1)?.message).toContain("Requirements: 0/3 complete");
  });

  it("stats scope counts to current milestone", () => {
    const root = createTempDirSync("agent-gsd-stats-milestone-");
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

    expect(notifications.at(-1)?.level).toBe("info");
    expect(notifications.at(-1)?.message).toContain("# v1.1");
    expect(notifications.at(-1)?.message).toContain("| 5 | Security | 1 | 0 | In Progress |");
  });

  it("stats scopes milestone phases from milestone range bullets without dedicated milestone containers", () => {
    const root = createTempDirSync("agent-gsd-stats-milestone-range-bullets-");
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-delivery"), { recursive: true });
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

### Phase 1: Foundation
**Goal**: Already shipped

Plans:
- [x] 01-01: Done

### Phase 2: Delivery
**Goal**: Already shipped

Plans:
- [x] 02-01: Done

### Phase 5: Security
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
    writeFileSync(join(root, ".planning", "phases", "2-delivery", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "5-security", "05-01-PLAN.md"),
      "---\nphase: 05\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/auth.ts]\nautonomous: true\nmust_haves: [secure]\n---\n",
    );

    expect(computeStructuredStats(root).phases.map((phase) => phase.number)).toEqual(["5"]);
  });

  it("stats scopes exact milestone bullet ranges instead of partial version matches", () => {
    const root = createTempDirSync("agent-gsd-stats-milestone-range-exact-");
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-release"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

## Milestones

- ✅ **v1.0 Foundation** - Phases 1-1
- 🚧 **v1.1 Release** - Phases 2-2

## Phases

### Phase 1: Foundation
**Goal**: Foundation

Plans:
- [ ] 01-01: Build base

### Phase 2: Release
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

  it("stats scopes shipped milestone phases from details summary blocks", () => {
    const root = createTempDirSync("agent-gsd-stats-milestone-details-");
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
    const root = createTempDirSync("agent-gsd-stats-milestone-exact-");
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

  it("stats derives milestone name from roadmap heading when state milestone_name is absent", () => {
    const root = createTempDirSync("agent-gsd-stats-milestone-name-heading-");
    mkdirSync(join(root, ".planning", "phases", "5-security"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### 🚧 v1.1 Security (In Progress)

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

    expect(computeStructuredStats(root)).toMatchObject({
      milestone_version: "v1.1",
      milestone_name: "Security",
    });
  });

  it("stats derives milestone name from roadmap details summary when state milestone_name is absent", () => {
    const root = createTempDirSync("agent-gsd-stats-milestone-name-details-");
    mkdirSync(join(root, ".planning", "phases", "5-security"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

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
      "milestone: v1.1\ncurrent_phase: 5\ncurrent_phase_name: Security\ncurrent_plan: 05-01\nstatus: Ready to execute\n",
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");

    expect(computeStructuredStats(root)).toMatchObject({
      milestone_version: "v1.1",
      milestone_name: "Security",
    });
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

  it("stats counts padded local summary ids against canonical roadmap plan ids", () => {
    const root = createTempDirSync("agent-gsd-stats-padded-summary-");
    mkdirSync(join(root, ".planning", "phases", "02-delivery"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 2: Delivery

**Goal**: Ship delivery

Plans:
- [ ] 2-01: Ship feature
`,
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "milestone: current\ncurrent_phase: 2\ncurrent_phase_name: Delivery\nstatus: Ready to execute\n",
    );
    writeFileSync(join(root, ".planning", "phases", "02-delivery", "02-01-SUMMARY.md"), "done\n");

    expect(computeStructuredStats(root)).toMatchObject({
      total_plans: 1,
      total_summaries: 1,
      plan_percent: 100,
      phases: [{ number: "2", summaries: 1, status: "Executed" }],
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
    expect(notifications.at(-1)?.message).toContain("Git commits: ");
    expect(notifications.at(-1)?.message).toContain("First commit: ");
    expect(notifications.at(-1)?.message).toContain("Project age: ");
    expect(notifications.at(-1)?.message).toContain("Last activity: ");
  });

  it("stats emits MVP phase summary when roadmap modes exist", () => {
    const root = createTempDirSync("agent-gsd-stats-mvp-mode-");
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 1: Foundation
**Goal**: Build base
**Mode**: mVp

Plans:
- [ ] 01-01: Create base

### Phase 2: Build
**Goal**: Ship feature

Plans:
- [ ] 02-01: Implement feature
`,
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");

    const { notifications, ctx } = createNotificationsForRoot(root);
    handleGsdStats({} as never, ctx as never, { outputMode: "table" });

    expect(notifications.at(-1)?.message).toContain("Phases: 2 total | 1 MVP | 1 standard");
    expect(computeStructuredStats(root)).toMatchObject({
      mvp_phases: 1,
      standard_phases: 1,
      phases: [
        expect.objectContaining({ number: "1", mode: "mvp" }),
        expect.objectContaining({ number: "2", mode: null }),
      ],
    });
  });

  it("stats decisions count excludes unrelated project tables", () => {
    const root = createTempDirSync("agent-gsd-stats-decisions-table-");
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(
      join(root, ".planning", "PROJECT.md"),
      [
        "# Demo",
        "",
        "## Summary Table",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Name | Demo |",
        "| Type | Brownfield |",
      ].join("\n"),
    );
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");

    expect(computeStructuredStats(root).decisions_count).toBe(0);
  });

  it("stats blocker count excludes unrelated blocker mentions outside blockers section", () => {
    const root = createTempDirSync("agent-gsd-stats-blockers-section-");
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      [
        "status: Ready to execute",
        "",
        "Notes: blocker terminology here is historical only.",
        "",
        "### Blockers/Concerns",
        "",
        "- Waiting on API token",
      ].join("\n"),
    );

    expect(computeStructuredStats(root).open_blockers).toBe(1);
  });

  it("stats structured output includes git history and state last_activity when repo exists", () => {
    const root = createTempDirSync("agent-gsd-stats-git-");
    mkdirSync(join(root, ".planning", "phases"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(join(root, ".planning", "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "last_activity: 2026-05-10T12:00:00.000Z\nstatus: Ready to execute\n",
    );

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    writeFileSync(join(root, "README.md"), "demo\n");
    execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

    expect(computeStructuredStats(root)).toMatchObject({
      git_commits: 1,
      git_first_commit_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      last_activity: "2026-05-10T12:00:00.000Z",
    });
  });

  it("stats falls back to latest planning artifact timestamp when state last_activity is absent", () => {
    const root = createTempDirSync("agent-gsd-stats-activity-");
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "# Roadmap: Demo",
        "",
        "### Phase 1: Setup",
        "",
        "Plans:",
        "- [ ] 01-01: Create config",
      ].join("\n"),
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    const summaryPath = join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md");
    writeFileSync(summaryPath, "done\n");
    const modified = new Date("2030-05-09T08:15:00.000Z");
    utimesSync(summaryPath, modified, modified);

    expect(computeStructuredStats(root).last_activity).toBe("2030-05-09T08:15:00.000Z");
  });

  it("stats falls back to latest planning artifact timestamp when state last_activity is invalid", () => {
    const root = createTempDirSync("agent-gsd-stats-activity-invalid-");
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "# Roadmap: Demo",
        "",
        "### Phase 1: Setup",
        "",
        "Plans:",
        "- [ ] 01-01: Create config",
      ].join("\n"),
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "last_activity: not-a-timestamp\n");
    const summaryPath = join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md");
    writeFileSync(summaryPath, "done\n");
    const modified = new Date("2031-06-01T09:00:00.000Z");
    utimesSync(summaryPath, modified, modified);

    expect(computeStructuredStats(root).last_activity).toBe("2031-06-01T09:00:00.000Z");
  });

  it("stats canonicalizes padded local phase ids and keeps executed work distinct from complete", () => {
    const root = createTempDirSync("agent-gsd-stats-phase-status-");
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

  it("stats ignores noncanonical UAT artifacts when deriving complete phase status", () => {
    const root = createTempDirSync("agent-gsd-stats-noncanonical-uat-");
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
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
`,
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-foundation", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/base.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-foundation", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-foundation", "99-UAT.md"),
      "---\nstatus: complete\n---\n\n# UAT\n",
    );

    expect(computeStructuredStats(root)).toMatchObject({
      phases: [expect.objectContaining({ number: "1", status: "Executed" })],
    });
  });

  it("stats ignores stale snapshot phases that are not present in roadmap", () => {
    const root = createTempDirSync("agent-gsd-stats-stale-phase-");
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "9-stale"), { recursive: true });
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
`,
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(join(root, ".planning", "phases", "1-foundation", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(join(root, ".planning", "phases", "9-stale", "09-01-SUMMARY.md"), "stale\n");

    expect(computeStructuredStats(root)).toMatchObject({
      phases_total: 1,
      total_summaries: 1,
      phases: [expect.objectContaining({ number: "1" })],
    });
  });

  it("stats ignores malformed summary ids that do not match roadmap plans", () => {
    const root = createTempDirSync("agent-gsd-stats-malformed-summaries-");
    mkdirSync(join(root, ".planning", "phases", "1-foundation"), { recursive: true });
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
`,
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(join(root, ".planning", "STATE.md"), "status: Ready to execute\n");
    writeFileSync(join(root, ".planning", "phases", "1-foundation", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-foundation", "01-extra-SUMMARY.md"),
      "junk\n",
    );

    expect(computeStructuredStats(root)).toMatchObject({
      total_summaries: 1,
      phases: [expect.objectContaining({ number: "1", summaries: 1, status: "Executed" })],
    });
  });

  it("stats counts requirements from checklist, plain bullets, and traceability status", () => {
    const root = createTempDirSync("agent-gsd-stats-requirements-");
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
    const root = createTempDirSync("agent-gsd-stats-requirements-semver-");
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
    const root = createTempDirSync("agent-gsd-stats-requirements-v1x-");
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
    const root = createTempDirSync("agent-gsd-stats-requirements-traceability-");
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
    const root = createTempDirSync("agent-gsd-stats-verification-only-status-");
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

  it("stats ignores noncanonical verification artifacts when deriving phase status and counts", () => {
    const root = createTempDirSync("agent-gsd-stats-noncanonical-verification-");
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
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/setup.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
    );
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"),
      "---\nstatus: passed\n---\n\n# Verification\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "99-VERIFICATION.md"),
      "---\nstatus: human_needed\n---\n\n# Verification\n",
    );

    expect(computeStructuredStats(root)).toMatchObject({
      verification_count: 1,
      phases: [expect.objectContaining({ number: "1", status: "Executed" })],
    });
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

  it("resolves packaged GSD agents under resources/gsd/agents", () => {
    const root = createTempDirSync("agent-gsd-packaged-agents-");
    const libDir = join(root, "dist", "resources", "gsd", "bin", "lib");
    const agentsDir = join(root, "dist", "resources", "gsd", "agents");
    mkdirSync(libDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });

    for (const agentName of Object.keys(gsdModelProfiles.MODEL_PROFILES)) {
      writeFileSync(join(agentsDir, `${agentName}.md`), `# ${agentName}\n`);
    }

    expect(gsdCore.resolveAgentsDir(libDir)).toBe(agentsDir);

    const agentStatus = gsdCore.checkAgentsInstalled(agentsDir);
    expect(agentStatus.agents_installed).toBe(true);
    expect(agentStatus.installed_agents).toContain("gsd-planner");
    expect(agentStatus.missing_agents).toEqual([]);
  });

  it("keeps GSD_AGENTS_DIR override above packaged resolver", () => {
    const root = createTempDirSync("agent-gsd-agents-env-override-");
    const libDir = join(root, "dist", "resources", "gsd", "bin", "lib");
    const overrideDir = join(root, "custom-agents");
    mkdirSync(libDir, { recursive: true });
    mkdirSync(overrideDir, { recursive: true });

    const previousAgentsDir = process.env.GSD_AGENTS_DIR;
    process.env.GSD_AGENTS_DIR = overrideDir;
    try {
      expect(gsdCore.resolveAgentsDir(libDir)).toBe(overrideDir);
    } finally {
      if (previousAgentsDir === undefined) {
        delete process.env.GSD_AGENTS_DIR;
      } else {
        process.env.GSD_AGENTS_DIR = previousAgentsDir;
      }
    }
  });

  it("health reports missing PROJECT.md as non-green", () => {
    const root = createTempDirSync("agent-gsd-health-missing-project-");
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
      ["Health broken errors=1 warnings=0 info=0", "ERROR E002: PROJECT.md not found"].join("\n"),
    );
    expect(notifications.at(-1)?.message).not.toContain("W010");
  });

  it("health reports malformed config as structured output instead of crashing", () => {
    const root = createTempDirSync("agent-gsd-health-malformed-config-");
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
