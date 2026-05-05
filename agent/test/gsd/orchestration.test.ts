import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  orchestrateExecutePhase,
  orchestratePlanPhase,
  orchestrateVerifyWork,
  type GsdOrchestrationDeps,
} from "../../src/extensions/gsd/orchestration.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-gsd-orch-"));
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
**Depends on**: Nothing
**Requirements**: [REQ-01]
**Success Criteria** (what must be TRUE):
  1. Repo bootstraps
**Plans**: 1 plan

Plans:
- [ ] 01-01: Create config
`,
  );
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    "current_phase: 1\ncurrent_phase_name: Setup\nstatus: Ready to plan\n",
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

describe("gsd orchestration", () => {
  it("plans phase and writes plan files after checker approval", async () => {
    const root = createRoot();
    const ctx = createContext(root);
    const deps: GsdOrchestrationDeps = {
      spawnPlanner: vi.fn().mockResolvedValue({
        plans: [
          {
            phase: "01",
            plan: "01",
            type: "implementation",
            wave: 1,
            depends_on: [],
            files_modified: ["src/index.ts"],
            autonomous: true,
            must_haves: ["works"],
          },
        ],
      }),
      spawnRole: vi.fn(),
      spawnStructuredRole: vi.fn().mockResolvedValueOnce({
        approved: true,
        summary: "ok",
        coverage: [{ requirement: "REQ-01", status: "covered", notes: "Task 1" }],
        issues: [],
      }),
    };
    const result = await orchestratePlanPhase({} as ExtensionAPI, ctx, deps);
    expect(result.planOutput.plans).toHaveLength(1);
    expect(deps.spawnPlanner).toHaveBeenCalledWith(
      {} as ExtensionAPI,
      ctx,
      expect.stringContaining("<required_reading>"),
    );
    expect(deps.spawnPlanner).toHaveBeenCalledWith(
      {} as ExtensionAPI,
      ctx,
      expect.stringContaining(join(root, ".planning", "ROADMAP.md")),
    );
    expect(deps.spawnStructuredRole).toHaveBeenCalledWith(
      {} as ExtensionAPI,
      ctx,
      "plan-checker",
      expect.stringContaining(join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md")),
      expect.anything(),
      2,
    );
    expect(readFileSync(result.planPaths[0] ?? "", "utf8")).toContain("phase: 01");
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-PLAN-CHECK.md"), "utf8"),
    ).toContain("approved: true");
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-PLAN-CHECK.md"), "utf8"),
    ).toContain("REQ-01: covered");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Ready to execute",
    );
  });

  it("executes phase then verifies and updates state", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/index.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
    );
    const ctx = createContext(root);
    const deps: GsdOrchestrationDeps = {
      spawnPlanner: vi.fn(),
      spawnRole: vi.fn().mockResolvedValue(undefined),
      spawnStructuredRole: vi.fn().mockResolvedValue({
        verified: true,
        summary: "verified",
        truths: [{ truth: "Repo bootstraps", status: "verified", evidence: "tests pass" }],
        blockers: [],
        warnings: [],
        uat_items: [{ name: "Smoke test", result: "pass" }],
      }),
    };
    const result = await orchestrateExecutePhase({} as ExtensionAPI, ctx, deps);
    expect(result.verified).toBe(true);
    expect(deps.spawnStructuredRole).toHaveBeenCalledWith(
      {} as ExtensionAPI,
      ctx,
      "verifier",
      expect.stringContaining("<required_reading>"),
      expect.anything(),
      2,
    );
    expect(deps.spawnStructuredRole).toHaveBeenCalledWith(
      {} as ExtensionAPI,
      ctx,
      "verifier",
      expect.stringContaining(join(root, ".planning", "phases", "1-setup")),
      expect.anything(),
      2,
    );
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"), "utf8"),
    ).toContain("verified: true");
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"), "utf8"),
    ).toContain("Repo bootstraps: verified");
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-VALIDATION.md"), "utf8"),
    ).toContain("Validated");
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-UAT.md"), "utf8"),
    ).toContain("Smoke test");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Phase complete",
    );
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain("current_plan: ");
  });

  it("verifies phase and writes artifacts without executor run", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/index.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
    );
    const ctx = createContext(root);
    const deps: GsdOrchestrationDeps = {
      spawnPlanner: vi.fn(),
      spawnRole: vi.fn(),
      spawnStructuredRole: vi.fn().mockResolvedValue({
        verified: true,
        summary: "verified directly",
        truths: [{ truth: "Repo bootstraps", status: "verified", evidence: "tests pass" }],
        blockers: [],
        warnings: [],
        uat_items: [{ name: "Smoke test", result: "pass" }],
      }),
    };
    const result = await orchestrateVerifyWork({} as ExtensionAPI, ctx, deps);
    expect(result.summary).toBe("verified directly");
    expect(deps.spawnRole).not.toHaveBeenCalled();
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"), "utf8"),
    ).toContain("verified directly");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Phase complete",
    );
  });

  it("preserves brownfield state content during plan-phase state writes", async () => {
    const root = createRoot();
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      [
        "---",
        'current_phase: "1"',
        "current_phase_name: Setup",
        "status: Ready to plan",
        "milestone: v1",
        "---",
        "",
        "# Project State",
        "",
        "Existing brownfield notes.",
        "",
      ].join("\n"),
    );
    const ctx = createContext(root);
    const deps: GsdOrchestrationDeps = {
      spawnPlanner: vi.fn().mockResolvedValue({
        plans: [
          {
            phase: "01",
            plan: "01",
            type: "implementation",
            wave: 1,
            depends_on: [],
            files_modified: ["src/index.ts"],
            autonomous: true,
            must_haves: ["works"],
          },
        ],
      }),
      spawnRole: vi.fn(),
      spawnStructuredRole: vi.fn().mockResolvedValueOnce({
        approved: true,
        summary: "ok",
        coverage: [{ requirement: "REQ-01", status: "covered", notes: "Task 1" }],
        issues: [],
      }),
    };
    await orchestratePlanPhase({} as ExtensionAPI, ctx, deps);
    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    expect(state).toContain("current_phase: 1");
    expect(state).toContain("current_phase_name: Setup");
    expect(state).toContain("current_plan: 01-01");
    expect(state).toContain("status: Ready to execute");
    expect(state).toContain("milestone: v1");
    expect(state).toContain("# Project State");
    expect(state).toContain("Existing brownfield notes.");
  });
});
