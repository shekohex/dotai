import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadBundledDoc,
  loadBundledPrompt,
  loadBundledTemplate,
} from "../../src/extensions/gsd/resources.js";
import { listGsdRoles } from "../../src/extensions/gsd/roles.js";

describe("gsd bundled resources", () => {
  it("loads shipped docs", () => {
    expect(loadBundledDoc("overview.md")).toContain("# Built-in GSD For Our Agent");
    expect(loadBundledDoc("architecture.md")).toContain("# GSD Architecture");
    expect(loadBundledDoc("user-guide.md")).toContain("# GSD User Guide");
    expect(loadBundledDoc("command-reference.md")).toContain("# GSD Command Reference");
    expect(loadBundledDoc("role-reference.md")).toContain("# GSD Role Reference");
    expect(loadBundledDoc("compatibility.md")).toContain("# GSD Compatibility Notes");
    expect(loadBundledDoc("checklist.md")).toContain("# GSD Delivery Checklist");
    expect(loadBundledDoc("audit.md")).toContain("# GSD Audit");
  });

  it("loads shipped prompt resources for every gsd role", () => {
    for (const role of listGsdRoles()) {
      const prompt = loadBundledPrompt(role);
      expect(prompt.startsWith("---\n")).toBeFalsy();
      expect(prompt).toContain("<role>");
      expect(prompt.includes("~/.claude/get-shit-done")).toBeFalsy();
    }
  });

  it("keeps codebase mapper prompt aligned with direct-write orchestrator contract", () => {
    const prompt = loadBundledPrompt("codebase-mapper");

    expect(prompt).toContain("write analysis documents directly to `.planning/codebase/`");
    expect(prompt).toContain("WRITE DOCUMENTS DIRECTLY.");
    expect(prompt).toContain("Return confirmation only");
  });

  it("keeps intel updater prompt aligned with local refresh contract", () => {
    const prompt = loadBundledPrompt("intel-updater");

    expect(prompt).toContain("`files.json`");
    expect(prompt).toContain("`apis.json`");
    expect(prompt).toContain("`deps.json`");
    expect(prompt).toContain("`arch.md`");
    expect(prompt).toContain("`stack.json`");
    expect(prompt).toContain("intel validate");
    expect(prompt).toContain("intel snapshot");
    expect(prompt).toContain("## INTEL UPDATE COMPLETE");
    expect(prompt).not.toContain("Glob");
    expect(prompt).not.toContain("Grep");
    expect(prompt).not.toContain("gsd-sdk query intel.extract-exports");
  });

  it("loads shipped templates", () => {
    expect(loadBundledTemplate("state.md")).toContain("STATE");
    expect(loadBundledTemplate("project.md")).toContain("Project");
    expect(loadBundledTemplate("requirements.md")).toContain("Requirements");
    expect(loadBundledTemplate("roadmap.md")).toContain("Roadmap");
    expect(loadBundledTemplate("roadmap-empty.md")).toContain("No phases yet.");
    expect(loadBundledTemplate("context.md")).toContain("Context");
    expect(loadBundledTemplate("research.md")).toContain("Research");
    expect(loadBundledTemplate("VALIDATION.md")).toContain("Validation");
    expect(loadBundledTemplate("UAT.md")).toContain("UAT");
  });

  it("ships workflow resources for new-project parity", () => {
    expect(loadBundledDoc("command-reference.md")).toContain("new-project");
  });

  it("ships execute-phase foundation resources and wording", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/execute-phase.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/execute-phase.md"),
      "utf8",
    );
    const worktreeGate = readFileSync(
      join(
        process.cwd(),
        "src/resources/gsd/workflows/execute-phase/steps/per-plan-worktree-gate.md",
      ),
      "utf8",
    );
    const postMergeGate = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/execute-phase/steps/post-merge-gate.md"),
      "utf8",
    );
    const codebaseDriftGate = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/execute-phase/steps/codebase-drift-gate.md"),
      "utf8",
    );
    const worktreeSafety = readFileSync(
      join(process.cwd(), "src/resources/gsd/references/worktree-path-safety.md"),
      "utf8",
    );
    const agentContracts = readFileSync(
      join(process.cwd(), "src/resources/gsd/references/agent-contracts.md"),
      "utf8",
    );
    const contextBudget = readFileSync(
      join(process.cwd(), "src/resources/gsd/references/context-budget.md"),
      "utf8",
    );

    expect(command).toContain("--wave");
    expect(command).toContain("--gaps-only");
    expect(command).toContain("--interactive");
    expect(command).toContain("--validate");
    expect(command).toContain("Deferred with explicit error:");
    expect(command).toContain("--cross-ai");
    expect(command).toContain("--no-cross-ai");
    expect(workflow).toContain("active flags are only flags present");
    expect(workflow).toContain("`--wave` filter is active for either `--wave <N>` or `--wave=<N>`");
    expect(workflow).toContain("inspect `branching_strategy` and `branch_name` from init payload");
    expect(workflow).toContain(
      "create `branch_name` from `origin/<default-branch>`, not current HEAD",
    );
    expect(workflow).toContain(
      'node "$GSD_TOOLS_PATH" state begin-phase --phase "<phase>" --name "<phase-name>" --plans "<plan-count>"',
    );
    expect(workflow).toContain("`state.begin-phase` must run before plan grouping");
    expect(workflow).toContain("wave discovery/filtering");
    expect(workflow).toContain("lower-wave safety");
    expect(workflow).toContain("intra-wave overlap downgrade");
    expect(workflow).toContain("sequential `run_in_background` dispatch wording");
    expect(workflow).toContain("completion-signal spot-check fallback");
    expect(workflow).toContain("worktree cleanup with pre-merge `--diff-filter=D`");
    expect(workflow).toContain("post-merge gate");
    expect(workflow).toContain("partial-wave stop-before-verify/complete");
    expect(workflow).toContain("verifier spawn");
    expect(workflow).toContain("human-UAT persistence");
    expect(workflow).toContain("phase.complete");
    expect(workflow).toContain("Only after successful post-merge gate, update roadmap progress");
    expect(workflow).toContain(
      "Scope regression gate to full-wave merged state, not per completed plan",
    );
    expect(workflow).toContain("selected wave complete; phase still in progress");
    expect(workflow).toContain('node "$GSD_TOOLS_PATH" init execute-phase "<phase>" --validate');
    expect(workflow).toContain('node "$GSD_TOOLS_PATH" phase-plan-index "<phase>"');
    expect(workflow).toContain("Use existing local runtime helpers");
    expect(workflow).toContain("GSD_BUNDLE_DIR");
    expect(workflow).not.toContain("{{GSD_BUNDLE_DIR}}/commands/gsd/execute-phase.md");
    expect(worktreeGate).toContain("currentPaths ∩ siblingPaths != ∅");
    expect(worktreeGate).toContain("parent-child overlap");
    expect(worktreeGate).toContain(
      "worktree isolation disabled for plan due to submodule/path safety gate",
    );
    expect(postMergeGate).toContain("build/test gate");
    expect(postMergeGate).toContain("full-wave merged tree");
    expect(postMergeGate).toContain("tracking guard on failed tests");
    expect(postMergeGate).toContain(
      "do not run `roadmap update-plan-progress` for that failed merged wave",
    );
    expect(codebaseDriftGate).toContain("non-blocking drift contract");
    expect(codebaseDriftGate).toContain('node "$GSD_TOOLS_PATH" verify codebase-drift');
    expect(agentContracts).toContain("workers return structured status");
    expect(contextBudget).toContain("orchestrator: keep near 15% budget");
    expect(worktreeSafety).toContain("Absolute-path contract");
  });

  it("new-project workflow encodes approval gate and deterministic instruction generation", () => {
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/new-project.md"),
      "utf8",
    );

    expect(workflow).toContain("If `commit_docs: false`, add `.planning/` to `.gitignore`");
    expect(workflow).toContain("## 8. Roadmap Approval");
    expect(workflow).toContain(
      "If `--auto`, skip this approval loop and treat roadmap as auto-approved.",
    );
    expect(workflow).toContain("If `--auto`, skip interactive requirements approval");
    expect(workflow).toContain('generate-claude-md --output "$INSTRUCTION_FILE_PATH"');
    expect(workflow).toContain(
      "This is local adapted workflow, not full upstream shell/runtime parity.",
    );
    expect(workflow).toContain("If `IS_BROWNFIELD=true`, do not ask generic greenfield intake");
    expect(workflow).toContain("If `IS_BROWNFIELD=true` and `NEEDS_CODEBASE_MAP=true`");
    expect(workflow).toContain(
      "If `CODEBASE_DOCS` is non-empty, read those `.planning/codebase/*.md` docs",
    );
    expect(workflow).toContain(
      "If brownfield codebase docs exist, infer current system capabilities/constraints",
    );
    expect(workflow).toContain("If steering metadata says `GIT_WORKTREE_READY=true`");
    expect(workflow).toContain("HAS_ACCIDENTAL_NESTED_GIT_REPO=true");
    expect(workflow).toContain("Researcher task contract:");
    expect(workflow).toContain("Roadmapper delegation contract:");
  });
});
