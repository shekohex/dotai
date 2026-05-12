import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadBundledDoc,
  loadBundledPrompt,
  loadBundledTemplate,
} from "../../src/extensions/gsd/resources.js";
import {
  getGsdAutocompleteFlags,
  getGsdSubcommands,
} from "../../src/extensions/gsd/autocomplete.js";
import { listGsdRoles } from "../../src/extensions/gsd/roles.js";

function extractBacktickedValues(section: string): string[] {
  return [...section.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

function extractAuditSection(document: string, heading: string, nextHeading: string): string {
  const start = document.indexOf(heading);
  const end = document.indexOf(nextHeading);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  return document.slice(start, end);
}

function extractImplementedAuditCommands(section: string): string[] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const match = line.match(/^\| `([^`]+)`\s+\|/u);

      expect(match?.[1]).toBeTruthy();

      return match?.[1] ?? "";
    });
}

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

  it("ships progress workflow-launch foundation resources and wording", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/progress.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/progress.md"),
      "utf8",
    );

    expect(command).toContain("workflow-launch foundation");
    expect(command).toContain("`--next` delegates to existing local next-routing behavior");
    expect(command).toContain("explicit unsupported-local error for `--do`, `--forensic`");
    expect(command).toContain("do not recreate old one-line TypeScript notifier");
    expect(workflow).toContain("move default `/gsd progress` from one-line notify output");
    expect(workflow).toContain('node "$GSD_TOOLS_PATH" init progress');
    expect(workflow).toContain('node "$GSD_TOOLS_PATH" progress json');
    expect(workflow).toContain(
      "Cross-check helper output against local `.planning/STATE.md`, `.planning/ROADMAP.md`",
    );
    expect(workflow).toContain("Default path here is read/review only");
    expect(workflow).toContain(
      "Preserve explicit unsupported handling for `--do` and `--forensic`",
    );
    expect(loadBundledDoc("command-reference.md")).toContain(
      "default route: bundled workflow-launch review session",
    );
    expect(loadBundledDoc("command-reference.md")).toContain(
      "structured/table output also includes git commit count, first commit date, and last activity",
    );
  });

  it("keeps command reference subcommand roster aligned with registered grouped surface", () => {
    const reference = loadBundledDoc("command-reference.md");

    for (const { value } of getGsdSubcommands()) {
      expect(reference).toContain(`/gsd ${value}`);
    }
  });

  it("keeps command reference honest for key local map-codebase and progress modes", () => {
    const reference = loadBundledDoc("command-reference.md");
    const flags = getGsdAutocompleteFlags();

    expect(reference).toContain("## Upstream Crosswalk");
    expect(reference).toContain(
      "Upstream `/gsd map` does not exist here. Use local `/gsd map-codebase`.",
    );
    expect(reference).toContain("## Unsupported Upstream Commands");
    expect(reference).toContain(
      "If upstream docs mention `/gsd <name>` command not listed below, command is unavailable in this repo.",
    );
    expect(reference).toContain("- `/gsd map-codebase`");
    expect(reference).toContain("flags: `--fast`, `--query <term|status|diff|refresh>`");
    expect(reference).toContain(
      "`--focus <tech|arch|quality|concerns|tech+arch>` only with `--fast`",
    );
    expect(reference).toContain("unsupported-local but explicit: `--paths <repo/path,...>`");
    expect(reference).not.toContain(
      "flags: `--paths <repo/path,...>`, `--fast`, `--focus <tech|arch|quality|concerns|tech+arch>`, `--query <term|status|diff|refresh>`",
    );

    expect(flags["map-codebase"]).toBeUndefined();
    expect(reference).toContain(
      "parsed with explicit unsupported-local error: `--do`, `--forensic`",
    );
    expect(reference).toContain("`--phase <phase>`, `--force` only with `/gsd progress --next`");
    expect(reference).toContain(
      "Non-UI `/gsd help` emits durable `gsd-help` message output; registered local renderer is intended handling path.",
    );
  });

  it("keeps coverage audit implemented and missing command sections aligned with runtime surface", () => {
    const audit = readFileSync(join(process.cwd(), "docs/gsd-command-coverage-audit.md"), "utf8");
    const implementedSection = extractAuditSection(
      audit,
      "Implemented locally:",
      "## Missing Commands",
    );
    const missingSection = extractAuditSection(
      audit,
      "Missing non-namespace commands:",
      "Upstream source roster:",
    );
    const runtimeSubcommands = new Set(getGsdSubcommands().map(({ value }) => value));
    const localOnlySubcommands = new Set(["next", "on", "off", "status"]);
    const upstreamMirroredRuntimeSubcommands = [...runtimeSubcommands].filter(
      (value) => !localOnlySubcommands.has(value),
    );
    const implementedCommands = new Set(extractImplementedAuditCommands(implementedSection));
    const missingCommands = new Set(extractBacktickedValues(missingSection));
    const upstreamMirroredAuditCommands = [...implementedCommands].filter(
      (value) => !localOnlySubcommands.has(value),
    );
    const missingCountMatch = audit.match(
      /Upstream has (\d+) non-namespace commands still missing locally\./u,
    );

    expect(missingCountMatch?.[1]).toBeTruthy();

    for (const subcommand of upstreamMirroredRuntimeSubcommands) {
      expect(implementedCommands.has(subcommand)).toBe(true);
      expect(missingCommands.has(subcommand)).toBe(false);
    }

    for (const subcommand of upstreamMirroredAuditCommands) {
      expect(runtimeSubcommands.has(subcommand)).toBe(true);
      expect(missingCommands.has(subcommand)).toBe(false);
    }

    expect(implementedCommands.has("secure-phase")).toBe(true);
    expect(missingCommands.has("secure-phase")).toBe(false);
    expect(implementedCommands.has("help")).toBe(true);
    expect(runtimeSubcommands.has("help")).toBe(true);
    expect(missingCommands.has("mvp-phase")).toBe(true);
    expect(missingCommands.size).toBe(Number(missingCountMatch?.[1]));
  });

  it("ships verify-work foundation resources and wording", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/verify-work.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/verify-work.md"),
      "utf8",
    );
    const uatTemplate = readFileSync(
      join(process.cwd(), "src/resources/gsd/templates/UAT.md"),
      "utf8",
    );

    expect(command).toContain("workflow-launch foundation");
    expect(command).toContain(".planning/phases/<phase-dir>/<phase>-UAT.md");
    expect(command).toContain("/gsd verify-work");
    expect(command).toContain("/gsd plan-phase");
    expect(command).toContain("/gsd execute-phase");
    expect(command).toContain("Rejected now:");
    expect(command).toContain("unknown flags");
    expect(workflow).toContain('node "$GSD_TOOLS_PATH" init verify-work "<phase>"');
    expect(workflow).toContain("ROADMAP fallback when phase dir missing");
    expect(workflow).toContain("archived milestone guard with reused phase number");
    expect(workflow).toContain("Do not call local native `orchestrateVerifyWork()` path");
    expect(workflow).toContain("writeVerificationReport()");
    expect(workflow).toContain("writeValidationArtifact()");
    expect(workflow).toContain("writeUatArtifact()");
    expect(workflow).toContain("phase selection from verifiable phases");
    expect(workflow).toContain(
      "Status helper must preserve `diagnosed` when stored in frontmatter",
    );
    expect(workflow).toContain("Not yet supported in this slice");
    expect(workflow).toContain("Playwright/Puppeteer auto-verification branch");
    expect(workflow).toContain("MVP-mode branch via `phase.mvp-mode`");
    expect(workflow).toContain("auto diagnosis via `diagnose-issues.md`");
    expect(workflow).toContain("artifact acknowledgment gate via `audit-open --json`");
    expect(workflow).toContain("transition workflow handoff and phase completion mutation");
    expect(uatTemplate).toContain("status: testing | partial | complete | diagnosed");
    expect(uatTemplate).toContain("Current Test");
    expect(uatTemplate).toContain("Summary");
    expect(uatTemplate).toContain("Gaps");
    expect(uatTemplate).toContain("blocked_by");
    expect(uatTemplate).toContain("root_cause");
    expect(uatTemplate).toContain("artifacts");
    expect(uatTemplate).toContain("missing");
    expect(uatTemplate).toContain("debug_session");
    expect(uatTemplate).toContain("single source of truth for verify progress");
    expect(uatTemplate).toContain("does not auto-run diagnosis, security gating, or transition");
  });

  it("ships validate-phase foundation resources and wording", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/validate-phase.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/validate-phase.md"),
      "utf8",
    );

    expect(command).toContain("workflow-launch foundation");
    expect(command).toContain(
      "last helper-ready local phase with roadmap-matching SUMMARY evidence",
    );
    expect(command).toContain("Rejected now:");
    expect(command).toContain("unknown flags");
    expect(command).toContain("do not use native template-writer shortcut");
    expect(command).toContain("nyquist_validation_enabled");
    expect(command).toContain("validation_state");
    expect(command).toContain("handler pre-seeds draft `*-VALIDATION.md` artifact");
    expect(workflow).toContain(
      "Do not recreate old native template-writer behavior as success path",
    );
    expect(workflow).toContain("$GSD_BUNDLE_DIR/templates/VALIDATION.md");
    expect(workflow).toContain("$GSD_BUNDLE_DIR/references/gates.md");
    expect(workflow).toContain('node "$GSD_TOOLS_PATH" init validate-phase "<phase>"');
    expect(workflow).toContain("last helper-ready roadmap-matching SUMMARY-backed phase");
    expect(workflow).toContain("fail closed");
    expect(workflow).toContain("selected phase has no `*-SUMMARY.md`");
    expect(workflow).toContain("nyquist_validation_enabled: false");
    expect(workflow).toContain("validation state");
    expect(workflow).toContain("pre-seed helper-reported create target");
    expect(workflow).toContain("revise that file in place");
    expect(workflow).toContain("validation_target_path");
    expect(workflow).toContain("validation_target_mode");
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
    expect(command).toContain("--cross-ai");
    expect(command).toContain("--no-cross-ai");
    expect(command).toContain("--auto");
    expect(command).toContain("--mvp");
    expect(command).toContain("--tdd");
    expect(command).toContain("workflow/runtime handling");
    expect(loadBundledDoc("command-reference.md")).toContain("--cross-ai");
    expect(loadBundledDoc("command-reference.md")).toContain("forward to bundled workflow/runtime");
    expect(loadBundledDoc("command-reference.md")).not.toContain(
      "unsupported-local error: `--cross-ai`, `--no-cross-ai`",
    );
    expect(workflow).toContain("active flags are only flags present");
    expect(workflow).toContain("`--wave` filter is active for either `--wave <N>` or `--wave=<N>`");
    expect(workflow).toContain(
      "Supported flags in this slice: `--wave`, `--gaps-only`, `--interactive`, `--validate`, `--cross-ai`, `--no-cross-ai`, `--auto`, `--mvp`, `--tdd`",
    );
    expect(workflow).toContain(
      "`--cross-ai`, `--no-cross-ai`, `--auto`, `--mvp`, and `--tdd` are workflow-native flags in this slice",
    );
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

  it("milestone-summary workflow encodes archived phase lookup, scoped stats, and state cleanliness", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/milestone-summary.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/milestone-summary.md"),
      "utf8",
    );

    expect(command).toContain(".planning/milestones/v{version}-phases/");
    expect(command).toContain(
      "`STATE.md` left unchanged unless user-visible final output explicitly includes a coordinated state update",
    );
    expect(workflow).toContain('PHASES_PATH=".planning/milestones/v${VERSION}-phases/"');
    expect(workflow).toContain(
      "do not assume `gsd-sdk query init.progress` can discover archived phase directories",
    );
    expect(workflow).toContain(
      "All git stats in this section must be milestone-scoped, not whole-repo scoped.",
    );
    expect(workflow).toContain(
      "If no previous tag exists, do not silently fall back to full history reachable from `v${VERSION}`.",
    );
    expect(workflow).toContain("Milestone artifact commit range");
    expect(workflow).toContain(
      "Do not derive the start boundary from the commit that created `.planning/milestones/v${VERSION}-phases/`",
    );
    expect(workflow).not.toContain('git log --oneline --since="<started_at_date>" | wc -l');
    expect(workflow).toContain(
      "Do not leave `.planning/STATE.md` dirty as a side effect of summary generation.",
    );
    expect(workflow).not.toContain("gsd-sdk query state.record-session");
  });
});
