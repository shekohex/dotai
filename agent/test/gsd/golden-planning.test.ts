import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleGsdHealth } from "../../src/extensions/gsd/instant/health.js";
import { handleGsdNext, resolveNextRoute } from "../../src/extensions/gsd/instant/next.js";
import { handleGsdStats } from "../../src/extensions/gsd/instant/stats.js";
import { handleGsdProgress } from "../../src/extensions/gsd/lifecycle/progress.js";
import { handleGsdValidatePhase } from "../../src/extensions/gsd/lifecycle/validate-phase.js";
import { buildGsdSystemContext } from "../../src/extensions/gsd/context.js";
import {
  createEmptyDiscussDraft,
  readDiscussCheckpoint,
  removeDiscussCheckpoint,
  writeDiscussArtifacts,
  writeDiscussCheckpoint,
} from "../../src/extensions/gsd/state/discuss.js";
import {
  finalizePlanPhaseArtifacts,
  validateCanonicalPlanArtifacts,
} from "../../src/extensions/gsd/state/plan-phase.js";
import { computeLocalHealthSummary } from "../../src/extensions/gsd/state/health.js";
import { computeProgress } from "../../src/extensions/gsd/state/progress.js";
import { readPlanningSnapshot } from "../../src/extensions/gsd/state/read.js";
import { readRoadmapPhases } from "../../src/extensions/gsd/state/roadmap.js";
import { writeStateFields } from "../../src/extensions/gsd/state/runtime.js";
import { computeStructuredStats } from "../../src/extensions/gsd/state/stats.js";
import { resolveValidatePhaseSelection } from "../../src/extensions/gsd/state/validate-phase.js";
import { resolveGsdBundlePath } from "../../src/extensions/gsd/resources.js";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

function createGoldenPlanningRoot(): string {
  const root = createTempDirSync("agent-gsd-golden-planning-");
  const planningDir = join(root, ".planning");
  const phase21Dir = join(planningDir, "phases", "21-extraction-and-storybook-parity");
  const phase22Dir = join(planningDir, "phases", "22-auth-route-migration-and-signoff");
  mkdirSync(phase21Dir, { recursive: true });
  mkdirSync(phase22Dir, { recursive: true });
  writeFileSync(
    join(planningDir, "config.json"),
    `${JSON.stringify(
      {
        mode: "interactive",
        profiles: {
          active_profile: "quality",
          presets: {},
          custom_overrides: {},
        },
        model_profile: "balanced",
        granularity: "fine",
        commit_docs: true,
        parallelization: false,
        workflow: {
          research: true,
          plan_check: true,
          verifier: true,
          nyquist_validation: true,
          ai_integration_phase: true,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(planningDir, "STATE.md"),
    `---
milestone: v1.2.1
current_phase: 22
current_phase_name: Auth Route Migration and Signoff
current_plan: "06"
status: complete
last_activity: 2026-06-10T21:40:01.000Z
---

## Current Position

- **Phase:** 22 (2 of 2) - Auth Route Migration and Signoff complete
- **Status:** Complete
- **Progress:** 100%
`,
  );
  writeFileSync(
    join(planningDir, "PROJECT.md"),
    `# Project

## Decisions

| Decision | Rationale |
| --- | --- |
| Keep legacy planning readable | Existing repositories depend on it |
`,
  );
  writeFileSync(
    join(planningDir, "REQUIREMENTS.md"),
    `# Requirements

- [x] AUTH-01: Auth migration complete
- [x] EXTR-01: Extraction complete
`,
  );
  writeFileSync(
    join(planningDir, "ROADMAP.md"),
    `# Roadmap

## v1.2.1 — **Auth Surface Migration** (shipped)

### Phase 21: Extraction and Storybook Parity
**Goal**: Extract auth system
**Requirements**: EXTR-01
**Plans**: 5 plans

Plans:
- [x] 21-01-PLAN.md — Freeze route ledger.
- [x] 21-02-PLAN.md — Publish auth Storybook primitives.
- [x] 21-03-PLAN.md — Extract auth components.
- [x] 21-04-PLAN.md — Publish parity checks.
- [x] 21-05-PLAN.md — Close extraction proof.

### Phase 22: Auth Route Migration and Signoff
**Goal**: Migrate auth routes
**Depends on**: Phase 21
**Requirements**: AUTH-01
**Plans**: 6 plans

Plans:
- [x] 22-00-PLAN.md — Create verification ledger.
- [x] 22-01-PLAN.md — Migrate sign in.
- [x] 22-02-PLAN.md — Migrate registration.
- [x] 22-03-PLAN.md — Migrate reset flow.
- [x] 22-04-PLAN.md — Migrate OAuth handoff.
- [x] 22-05-PLAN.md — Final signoff.
`,
  );

  for (const planId of [
    "21-01",
    "21-02",
    "21-03",
    "21-04",
    "21-05",
    "22-00",
    "22-01",
    "22-02",
    "22-03",
    "22-04",
    "22-05",
  ]) {
    const phase = planId.startsWith("21") ? "21" : "22";
    const phaseDir = phase === "21" ? phase21Dir : phase22Dir;
    writeFileSync(join(phaseDir, `${planId}-PLAN.md`), buildLegacyPlan(planId, phase));
    writeFileSync(join(phaseDir, `${planId}-SUMMARY.md`), `# ${planId} summary\n`);
  }
  writeFileSync(join(phase21Dir, "21-VERIFICATION.md"), "---\nstatus: passed\n---\n");
  writeFileSync(join(phase22Dir, "22-VERIFICATION.md"), "---\nstatus: ready_for_closeout\n---\n");
  return root;
}

function buildLegacyPlan(planId: string, phase: string): string {
  const plan = planId.split("-")[1] ?? "01";
  const isRichRaptorsPlan = planId === "22-05";
  return `---
phase: ${phase}-legacy-slug
plan: "${plan}"
type: execute
wave: ${isRichRaptorsPlan ? "5" : "1"}
depends_on:${isRichRaptorsPlan ? "\n  - 22-00\n  - 22-04" : " []"}
files_modified:${isRichRaptorsPlan ? "\n  - .planning/phases/22-auth-route-migration-and-signoff/22-VERIFICATION.md" : " []"}
autonomous: ${isRichRaptorsPlan ? "false" : "true"}
${isRichRaptorsPlan ? "requirements:\n  - AUTH-05\n  - QUAL-01\n" : ""}must_haves:
  artifacts:
    - path: src/example.ts
      contains: "legacy"
  key_links:
    - from: a
      to: b
      via: \`legacy plain scalar\`
---

<objective>${planId}</objective>

<tasks>
<task type="auto">
  <name>task 1: preserve compatibility for ${planId}</name>
  <action>Keep legacy planning artifacts readable.</action>
</task>
</tasks>
`;
}

function createCommandContext(cwd: string) {
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

describe("GSD golden legacy planning compatibility", () => {
  it("reads the real Raptors golden snapshot when available", () => {
    const root = "/tmp/raptors-planning-b5yYAG";
    if (!existsSync(join(root, ".planning"))) {
      return;
    }

    const snapshot = readPlanningSnapshot(root);
    const stats = computeStructuredStats(root);

    expect(snapshot.readIssues).toEqual([]);
    expect(snapshot.phases.map((phase) => [phase.id, phase.plans.length])).toEqual([
      ["21-extraction-and-storybook-parity", 5],
      ["22-auth-route-migration-and-signoff", 6],
    ]);
    expect(
      snapshot.phases
        .find((phase) => phase.id === "22-auth-route-migration-and-signoff")
        ?.plans.find((plan) => plan.fileName === "22-05-PLAN.md")?.frontmatter,
    ).toMatchObject({
      wave: "5",
      requirements: ["AUTH-05", "QUAL-01", "QUAL-02", "QUAL-03"],
      autonomous: false,
    });
    expect(resolveNextRoute(root)).toMatchObject({ route: "complete-milestone" });
    expect(computeProgress(root)).toMatchObject({ completedPlans: 11, percent: 100 });
    expect(stats).toMatchObject({
      total_plans: 11,
      total_summaries: 11,
      requirements_total: 13,
      requirements_complete: 13,
      percent: 100,
    });
    expect(computeLocalHealthSummary(root)).toMatchObject({ status: "healthy", healthy: true });
    expect(buildGsdSystemContext(root)).toContain("Progress: 100%");
  });

  it("keeps current legacy .planning readable across state readers", () => {
    const root = createGoldenPlanningRoot();
    const snapshot = readPlanningSnapshot(root);

    expect(snapshot.phases.map((phase) => [phase.id, phase.plans.length])).toEqual([
      ["21-extraction-and-storybook-parity", 5],
      ["22-auth-route-migration-and-signoff", 6],
    ]);
    expect(
      snapshot.phases
        .find((phase) => phase.id === "22-auth-route-migration-and-signoff")
        ?.plans.find((plan) => plan.fileName === "22-05-PLAN.md")?.frontmatter,
    ).toMatchObject({
      phase: "22-legacy-slug",
      plan: "05",
      type: "execute",
      wave: "5",
      autonomous: false,
      requirements: ["AUTH-05", "QUAL-01"],
      depends_on: ["22-00", "22-04"],
      files_modified: [".planning/phases/22-auth-route-migration-and-signoff/22-VERIFICATION.md"],
      must_haves: {
        artifacts: [expect.objectContaining({ path: "src/example.ts", contains: "legacy" })],
        key_links: [expect.objectContaining({ from: "a", to: "b" })],
      },
    });
    expect(readRoadmapPhases(root).map((phase) => phase.plans.map((plan) => plan.id))).toEqual([
      ["21-01", "21-02", "21-03", "21-04", "21-05"],
      ["22-00", "22-01", "22-02", "22-03", "22-04", "22-05"],
    ]);
    expect(resolveNextRoute(root)).toMatchObject({
      advanced: true,
      route: "complete-milestone",
      reason: "milestone ready to complete",
    });
    expect(computeProgress(root)).toMatchObject({
      milestone: "v1.2.1",
      currentPhase: "22",
      currentPlan: "06",
      completedPlans: 11,
      percent: 100,
      status: "complete",
    });
    expect(computeStructuredStats(root)).toMatchObject({
      milestone_version: "v1.2.1",
      milestone_name: "Auth Surface Migration",
      phases_completed: 2,
      phases_total: 2,
      total_plans: 11,
      total_summaries: 11,
      percent: 100,
      plan_percent: 100,
      requirements_total: 2,
      requirements_complete: 2,
      verification_count: 2,
      phases: [
        expect.objectContaining({ number: "21", status: "Complete" }),
        expect.objectContaining({ number: "22", status: "Complete" }),
      ],
    });
    expect(computeLocalHealthSummary(root)).toMatchObject({ status: "healthy", healthy: true });
    expect(buildGsdSystemContext(root)).toContain("Progress: 100%");
  });

  it("keeps bundled progress helper aligned with ready-for-closeout status aliases", () => {
    const root = createGoldenPlanningRoot();
    const stdout = execFileSync(
      process.execPath,
      [resolveGsdBundlePath("bin", "gsd-tools.cjs"), "progress", "json", "--raw", "--cwd", root],
      { encoding: "utf8" },
    );

    expect(JSON.parse(stdout)).toMatchObject({
      percent: 100,
      phases: [
        expect.objectContaining({ number: "21", status: "Complete" }),
        expect.objectContaining({ number: "22", status: "Complete" }),
      ],
    });
  });

  it("bundled progress helper ignores nested verification status aliases", () => {
    const root = createGoldenPlanningRoot();
    writeFileSync(
      join(
        root,
        ".planning",
        "phases",
        "22-auth-route-migration-and-signoff",
        "22-VERIFICATION.md",
      ),
      `---
status: human_needed
human_review:
  status: approved
---

status: approved
`,
    );

    expect(computeStructuredStats(root).phases).toContainEqual(
      expect.objectContaining({ number: "22", status: "Human Needed" }),
    );

    const stdout = execFileSync(
      process.execPath,
      [resolveGsdBundlePath("bin", "gsd-tools.cjs"), "progress", "json", "--raw", "--cwd", root],
      { encoding: "utf8" },
    );

    expect(JSON.parse(stdout).phases).toContainEqual(
      expect.objectContaining({ number: "22", status: "Needs Review" }),
    );
  });

  it("bundled progress helper ignores body-only verification status aliases", () => {
    const root = createGoldenPlanningRoot();
    writeFileSync(
      join(
        root,
        ".planning",
        "phases",
        "22-auth-route-migration-and-signoff",
        "22-VERIFICATION.md",
      ),
      `# Verification

status: approved
`,
    );

    expect(computeStructuredStats(root).phases).toContainEqual(
      expect.objectContaining({ number: "22", status: "Executed" }),
    );

    const stdout = execFileSync(
      process.execPath,
      [resolveGsdBundlePath("bin", "gsd-tools.cjs"), "progress", "json", "--raw", "--cwd", root],
      { encoding: "utf8" },
    );

    expect(JSON.parse(stdout).phases).toContainEqual(
      expect.objectContaining({ number: "22", status: "Executed" }),
    );
  });

  it("bundled progress helper matches TS verified-field and exact-status semantics", () => {
    const root = createGoldenPlanningRoot();
    const verificationPath = join(
      root,
      ".planning",
      "phases",
      "22-auth-route-migration-and-signoff",
      "22-VERIFICATION.md",
    );
    writeFileSync(verificationPath, "---\nverified: approved\n---\n");

    let stdout = execFileSync(
      process.execPath,
      [resolveGsdBundlePath("bin", "gsd-tools.cjs"), "progress", "json", "--raw", "--cwd", root],
      { encoding: "utf8" },
    );
    expect(JSON.parse(stdout).phases).toContainEqual(
      expect.objectContaining({ number: "22", status: "Complete" }),
    );

    writeFileSync(verificationPath, "---\nstatus: approved_with_gaps\n---\n");
    stdout = execFileSync(
      process.execPath,
      [resolveGsdBundlePath("bin", "gsd-tools.cjs"), "progress", "json", "--raw", "--cwd", root],
      { encoding: "utf8" },
    );
    expect(JSON.parse(stdout).phases).toContainEqual(
      expect.objectContaining({ number: "22", status: "Executed" }),
    );
  });

  it("bundled progress helper ignores noncanonical verification artifacts", () => {
    const root = createGoldenPlanningRoot();
    const phaseDir = join(root, ".planning", "phases", "22-auth-route-migration-and-signoff");
    writeFileSync(join(phaseDir, "22-VERIFICATION.md"), "# verification without status\n");
    writeFileSync(join(phaseDir, "99-VERIFICATION.md"), "---\nstatus: human_needed\n---\n");

    const stdout = execFileSync(
      process.execPath,
      [resolveGsdBundlePath("bin", "gsd-tools.cjs"), "progress", "json", "--raw", "--cwd", root],
      { encoding: "utf8" },
    );

    expect(JSON.parse(stdout).phases).toContainEqual(
      expect.objectContaining({ number: "22", status: "Executed" }),
    );
  });

  it("plan-phase validation accepts legacy phase slugs and rich plan frontmatter", () => {
    const root = createGoldenPlanningRoot();

    expect(
      validateCanonicalPlanArtifacts(
        join(root, ".planning", "phases", "22-auth-route-migration-and-signoff"),
        "22",
      ),
    ).toHaveLength(6);
  });

  it("keeps legacy .planning readable through instant command handlers", async () => {
    const root = createGoldenPlanningRoot();

    const next = createCommandContext(root);
    await handleGsdNext({} as never, next.ctx as never, {});
    expect(next.notifications.at(-1)).toMatchObject({
      level: "warning",
      message:
        "Next requires workflow session for /gsd complete-milestone. Cannot safely fall back to pointer-only state updates.",
    });

    const progressNext = createCommandContext(root);
    await handleGsdProgress({} as never, progressNext.ctx as never, { next: true });
    expect(progressNext.notifications.at(-1)).toMatchObject(next.notifications.at(-1) ?? {});

    const stats = createCommandContext(root);
    handleGsdStats({} as never, stats.ctx as never, { outputMode: "json" });
    expect(JSON.parse(stats.notifications.at(-1)?.message ?? "{}")).toMatchObject({
      percent: 100,
      phases_completed: 2,
      total_plans: 11,
      total_summaries: 11,
    });

    const health = createCommandContext(root);
    await handleGsdHealth({} as never, health.ctx as never, {});
    expect(health.notifications.at(-1)?.message).not.toContain("PLAN");
    expect(health.notifications.at(-1)?.message).not.toContain("frontmatter");
  });

  it("mutates STATE and ROADMAP without losing legacy milestone metadata", () => {
    const root = createGoldenPlanningRoot();
    const roadmapPhase = readRoadmapPhases(root).find((phase) => phase.number === "22");
    expect(roadmapPhase).toBeDefined();

    writeStateFields(root, {
      current_phase: "22",
      current_phase_name: "Auth Route Migration and Signoff",
      current_plan: "22-00",
      status: "Ready to execute",
    });
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "milestone: v1.2.1",
    );

    finalizePlanPhaseArtifacts({
      cwd: root,
      phase: roadmapPhase!,
      phasePrefix: "22",
      validPlans: [
        {
          path: join(
            root,
            ".planning",
            "phases",
            "22-auth-route-migration-and-signoff",
            "22-00-PLAN.md",
          ),
          fileName: "22-00-PLAN.md",
          frontmatter: {
            phase: "22",
            plan: "00",
            type: "execute",
            wave: "1",
            depends_on: [],
            files_modified: [],
            autonomous: true,
            must_haves: [],
          },
          body: "",
        },
      ],
    });

    const state = readPlanningSnapshot(root).state;
    expect(state).toMatchObject({
      milestone: "v1.2.1",
      current_phase: "22",
      current_phase_name: "Auth Route Migration and Signoff",
      current_plan: "22-00",
      status: "Ready to execute",
    });
    expect(readFileSync(join(root, ".planning", "ROADMAP.md"), "utf8")).toContain(
      "**Plans**: 1 plan",
    );
  });

  it("resolves validation target from legacy completed phase artifacts", () => {
    const root = createGoldenPlanningRoot();

    expect(resolveValidatePhaseSelection(root, "22")).toMatchObject({
      selection: {
        phaseFilePrefix: "22",
        phaseDir: expect.stringContaining("22-auth-route-migration-and-signoff"),
      },
    });
  });

  it("writes discuss artifacts and checkpoints beside legacy phase artifacts", () => {
    const root = createGoldenPlanningRoot();
    const phaseDir = join(root, ".planning", "phases", "22-auth-route-migration-and-signoff");
    const draft = createEmptyDiscussDraft("Phase 22: Auth Route Migration and Signoff");
    draft.implementationDecisions.push({
      id: "D-001",
      area: "planning compatibility",
      decision: "Keep legacy planning readable",
      source: "user",
    });
    draft.discussionLog.push("Phase 22 compatibility reviewed.");

    writeDiscussArtifacts(phaseDir, "22", draft);
    expect(readFileSync(join(phaseDir, "22-CONTEXT.md"), "utf8")).toContain(
      "Keep legacy planning readable",
    );
    expect(readFileSync(join(phaseDir, "22-DISCUSSION-LOG.md"), "utf8")).toContain("Phase 22");

    writeDiscussCheckpoint(phaseDir, {
      phase: "22",
      mode: "discuss",
      route: "default-discuss",
      all: false,
      auto: false,
      chain: false,
      text: false,
      stage: "init",
      pendingPrompt: "",
      promptOptions: [],
      priorContextSummary: "",
      scoutSummary: "",
      areaQuestions: {},
      areaSelections: {},
      areasCompleted: [],
      areasRemaining: [],
      assumptionsAutoReady: false,
      assumptionsResearchGaps: [],
      deferredIdeas: [],
      canonicalReferences: [".planning/ROADMAP.md"],
      draft,
    });
    expect(readDiscussCheckpoint(phaseDir)).toMatchObject({ phase: "22" });
    removeDiscussCheckpoint(phaseDir);
    expect(readDiscussCheckpoint(phaseDir)).toBeUndefined();
  });

  it("validate-phase writes validation draft for legacy selected phase before workflow launch", async () => {
    const root = createGoldenPlanningRoot();
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      cwd: root,
      hasUI: false,
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getLeafId: () => "leaf",
        getSessionFile: () => undefined,
      },
      fork: async () => ({ cancelled: true }),
      newSession: async () => ({ cancelled: true }),
    };

    await handleGsdValidatePhase({} as never, ctx as never, { phase: "22" }, "validate-phase 22");

    expect(
      readFileSync(
        join(
          root,
          ".planning",
          "phases",
          "22-auth-route-migration-and-signoff",
          "22-VALIDATION.md",
        ),
        "utf8",
      ),
    ).toContain("Phase 22");
    expect(notifications).toEqual([]);
  });
});
