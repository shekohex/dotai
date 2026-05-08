import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-gsd-execute-phase-"));
}

function initRepo(root: string): void {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
    stdio: "ignore",
  });
}

function runTool(root: string, ...args: string[]): unknown {
  const toolPath = join(process.cwd(), "src/resources/gsd/bin/gsd-tools.cjs");
  return JSON.parse(
    execFileSync("node", [toolPath, ...args], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as unknown;
}

function createExecutePhaseFixture(root: string): void {
  mkdirSync(join(root, ".planning", "phases", "02-delivery"), { recursive: true });
  mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
  writeFileSync(
    join(root, ".planning", "config.json"),
    `${JSON.stringify({ workflow: { drift_action: "auto-remap", drift_threshold: 1 } })}\n`,
  );
  writeFileSync(
    join(root, ".planning", "ROADMAP.md"),
    [
      "| Phase | Plans | Status | Completed |",
      "| --- | --- | --- | --- |",
      "| 02 Delivery | 0/2 | Planned |  |",
      "",
      "### Phase 02: Delivery",
      "",
      "**Goal**: ship",
      "",
      "**Plans:** 0/2 plans executed",
      "",
      "Plans:",
      "- [ ] 02-01: plan one",
      "- [ ] 02-02: plan two",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    [
      "current_phase: 02",
      "current_phase_name: Delivery",
      "current_plan: 02-01",
      "status: Ready to execute",
      "Total Plans in Phase: 2",
    ].join("\n"),
  );
  writeFileSync(
    join(root, ".planning", "phases", "02-delivery", "02-01-PLAN.md"),
    "---\nphase: 02\nplan: 01\nwave: 1\nautonomous: true\nfiles_modified:\n  - src/a.ts\n---\n<objective>Plan one</objective>\n",
  );
  writeFileSync(
    join(root, ".planning", "phases", "02-delivery", "02-02-PLAN.md"),
    "---\nphase: 02\nplan: 02\nwave: 2\nautonomous: false\nfiles_modified:\n  - src/b.ts\n---\n<objective>Plan two</objective>\n",
  );
}

describe("execute-phase helper and workflow invariants", () => {
  it("keeps workflow ordering invariants in resource", () => {
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/execute-phase.md"),
      "utf8",
    );

    const branchingIndex = workflow.indexOf("## 3. Handle Branching");
    const beginPhaseIndex = workflow.indexOf("## 5. Persist Phase Start State");
    const executionIndex = workflow.indexOf("## 8. Execute Waves");
    const partialWaveIndex = workflow.indexOf("## 11. Partial-Wave Handling");
    const regressionIndex = workflow.indexOf("## 12. Regression Gate");
    const schemaIndex = workflow.indexOf("## 13. Schema Drift Gate");
    const codebaseIndex = workflow.indexOf("## 14. Codebase Drift Gate");
    const verifierIndex = workflow.indexOf("## 15. Verify Phase Goal");
    const completeIndex = workflow.indexOf("## 16. Update Roadmap And Phase Complete Path");

    expect(branchingIndex).toBeGreaterThan(-1);
    expect(beginPhaseIndex).toBeGreaterThan(branchingIndex);
    expect(executionIndex).toBeGreaterThan(-1);
    expect(executionIndex).toBeGreaterThan(beginPhaseIndex);
    expect(partialWaveIndex).toBeGreaterThan(executionIndex);
    expect(regressionIndex).toBeGreaterThan(partialWaveIndex);
    expect(schemaIndex).toBeGreaterThan(regressionIndex);
    expect(codebaseIndex).toBeGreaterThan(schemaIndex);
    expect(verifierIndex).toBeGreaterThan(codebaseIndex);
    expect(completeIndex).toBeGreaterThan(verifierIndex);
  });

  it("keeps roadmap progress update behind wave-level post-merge gate", () => {
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/execute-phase.md"),
      "utf8",
    );

    const aggregateIndex = workflow.indexOf("## 10. Aggregate Results");
    const roadmapAfterGateIndex = workflow.indexOf(
      "Only after successful post-merge gate, update roadmap progress",
    );
    const regressionWaveScopeIndex = workflow.indexOf(
      "Scope regression gate to full-wave merged state, not per completed plan",
    );

    expect(aggregateIndex).toBeGreaterThan(-1);
    expect(regressionWaveScopeIndex).toBeGreaterThan(aggregateIndex);
    expect(roadmapAfterGateIndex).toBeGreaterThan(aggregateIndex);
  });

  it("keeps branch handling and state.begin-phase ahead of discovery", () => {
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/execute-phase.md"),
      "utf8",
    );

    const branchingIndex = workflow.indexOf("## 3. Handle Branching");
    const beginPhaseIndex = workflow.indexOf("## 5. Persist Phase Start State");
    const discoveryIndex = workflow.indexOf("## 6. Discover And Group Plans");
    const branchFailFastIndex = workflow.indexOf(
      "create `branch_name` from `origin/<default-branch>`, not current HEAD",
    );
    const beginPhaseCommandIndex = workflow.indexOf(
      'node "$GSD_TOOLS_PATH" state begin-phase --phase "<phase>" --name "<phase-name>" --plans "<plan-count>"',
    );

    expect(branchingIndex).toBeGreaterThan(-1);
    expect(beginPhaseIndex).toBeGreaterThan(branchingIndex);
    expect(discoveryIndex).toBeGreaterThan(beginPhaseIndex);
    expect(branchFailFastIndex).toBeGreaterThan(branchingIndex);
    expect(beginPhaseCommandIndex).toBeGreaterThan(beginPhaseIndex);
  });

  it("phase-plan-index smoke groups plans into waves", () => {
    const root = createRoot();
    createExecutePhaseFixture(root);

    expect(runTool(root, "phase-plan-index", "02")).toEqual({
      phase: "02",
      plans: [
        expect.objectContaining({ id: "02-01", wave: 1, has_summary: false }),
        expect.objectContaining({ id: "02-02", wave: 2, has_summary: false }),
      ],
      waves: { "1": ["02-01"], "2": ["02-02"] },
      incomplete: ["02-01", "02-02"],
      has_checkpoints: true,
    });
  });

  it("roadmap update-plan-progress smoke updates phase row from disk", () => {
    const root = createRoot();
    createExecutePhaseFixture(root);
    writeFileSync(join(root, ".planning", "phases", "02-delivery", "02-01-SUMMARY.md"), "done\n");

    const result = runTool(root, "roadmap", "update-plan-progress", "02") as {
      updated: boolean;
      summary_count: number;
      plan_count: number;
      status: string;
    };
    const roadmap = readFileSync(join(root, ".planning", "ROADMAP.md"), "utf8");

    expect(result).toEqual(
      expect.objectContaining({
        updated: true,
        summary_count: 1,
        plan_count: 2,
        status: "In Progress",
      }),
    );
    expect(roadmap).toContain("1/2");
    expect(roadmap).toContain("In Progress");
  });

  it("phase complete smoke marks phase done", () => {
    const root = createRoot();
    createExecutePhaseFixture(root);
    writeFileSync(join(root, ".planning", "phases", "02-delivery", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(join(root, ".planning", "phases", "02-delivery", "02-02-SUMMARY.md"), "done\n");

    const result = runTool(root, "phase", "complete", "02") as {
      completed_phase: string;
      plans_executed: string;
      roadmap_updated: boolean;
      state_updated: boolean;
    };
    const roadmap = readFileSync(join(root, ".planning", "ROADMAP.md"), "utf8");

    expect(result).toEqual(
      expect.objectContaining({
        completed_phase: "02",
        plans_executed: "2/2",
        roadmap_updated: true,
        state_updated: true,
      }),
    );
    expect(roadmap).toContain("Complete");
  });

  it("verify codebase-drift smoke stays non-blocking", () => {
    const root = createRoot();
    initRepo(root);
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

    const result = runTool(root, "verify", "codebase-drift") as {
      skipped: boolean;
      action_required: boolean;
    };

    expect(result).toEqual(expect.objectContaining({ skipped: true, action_required: false }));
  });
});
