import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleGsdHealth } from "../../src/extensions/gsd/instant/health.js";
import { handleGsdProgress } from "../../src/extensions/gsd/instant/progress.js";
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
  it("progress emits deterministic summary", () => {
    const { notifications, ctx } = createNotifications();
    handleGsdProgress({} as never, ctx as never);
    expect(notifications.at(-1)).toEqual({
      message: "Progress ███░░░░░░░ 33% phase=1 plan=01-02",
      level: "info",
    });
  });

  it("progress includes milestone when present", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-gsd-progress-milestone-"));
    mkdirSync(join(root, ".planning", "phases", "5-security"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

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
    writeFileSync(
      join(root, ".planning", "phases", "5-security", "05-01-PLAN.md"),
      "---\nphase: 05\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/auth.ts]\nautonomous: true\nmust_haves: [secure]\n---\n",
    );

    const notifications: Array<{ message: string; level: string }> = [];
    handleGsdProgress(
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
      message: "Progress ░░░░░░░░░░ 0% milestone=v1.1 phase=5 plan=05-01",
      level: "info",
    });
  });

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

  it("stats json emits structured output", () => {
    const { notifications, ctx } = createNotifications();
    handleGsdStats({} as never, ctx as never, { outputMode: "json" });
    expect(JSON.parse(notifications.at(-1)?.message ?? "")).toMatchObject({
      milestone_version: "current",
      phases_total: 2,
      total_plans: 3,
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
    expect(notifications.at(-1)?.level).toBe("info");
    expect(notifications.at(-1)?.message).toContain("Health ok");
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

    expect(notifications.at(-1)).toEqual({
      message: "Health bad error:PROJECT.md",
      level: "warning",
    });
  });

  it("fixture state remains unchanged after instant commands", () => {
    const stateBefore = readFileSync(join(brownfieldRoot, ".planning", "STATE.md"), "utf8");
    const { ctx } = createNotifications();
    handleGsdProgress({} as never, ctx as never);
    handleGsdStats({} as never, ctx as never);
    handleGsdHealth({} as never, ctx as never);
    const stateAfter = readFileSync(join(brownfieldRoot, ".planning", "STATE.md"), "utf8");
    expect(stateAfter).toBe(stateBefore);
  });
});
