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

function extractCoverageByCommandFromAuditTable(section: string): Map<string, number> {
  return new Map(
    section
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => {
        const match = line.match(/^\| `([^`]+)`\s+\|.*\|\s+(\d+)\s+\|$/u);

        expect(match?.[1]).toBeTruthy();
        expect(match?.[2]).toBeTruthy();

        return [match?.[1] ?? "", Number.parseInt(match?.[2] ?? "0", 10)] as const;
      }),
  );
}

function extractCoverageByCommandFromCoverageSections(document: string): Map<string, number> {
  return new Map(
    [...document.matchAll(/^### `([^`]+)`\n\nCoverage: (\d+)\/100$/gmu)].map((match) => [
      match[1] ?? "",
      Number.parseInt(match[2] ?? "0", 10),
    ]),
  );
}

function extractCoverageByCommandFromCompletionAuditTable(document: string): Map<string, number> {
  const section = extractAuditSection(
    document,
    "Implemented locally:",
    "## Prompt-To-Artifact Checklist",
  );

  return new Map(
    section
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => {
        const match = line.match(/^\| `([^`]+)`\s+\|\s+(\d+)\s+\|/u);

        expect(match?.[1]).toBeTruthy();
        expect(match?.[2]).toBeTruthy();

        return [match?.[1] ?? "", Number.parseInt(match?.[2] ?? "0", 10)] as const;
      }),
  );
}

function normalizeDocumentedFlag(value: string): string {
  return value.endsWith("=") ? value.slice(0, -1) : value;
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
    expect(command).toContain(
      "fails closed when core planning files required for truthful progress review are missing",
    );
    expect(command).toContain("do not recreate old one-line TypeScript notifier");
    expect(workflow).toContain("move default `/gsd progress` from one-line notify output");
    expect(workflow).toContain('node "$GSD_TOOLS_PATH" init progress');
    expect(workflow).toContain('node "$GSD_TOOLS_PATH" progress json');
    expect(workflow).toContain("Local handler may stop before workflow launch");
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
      "structured/table output also includes git commit count, first commit date, project age, and last activity",
    );
  });

  it("ships new-milestone workflow contract for reset, state switch, and commit branches", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/new-milestone.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/new-milestone.md"),
      "utf8",
    );

    expect(command).toContain("Preserve all workflow gates");
    expect(workflow).toContain("`--reset-phase-numbers` flag");
    expect(workflow).toContain("`--text` flag");
    expect(workflow).toContain('gsd-sdk query state.milestone-switch --milestone "v[X.Y]"');
    expect(workflow).toContain("gsd-sdk query phases.clear --confirm");
    expect(workflow).toContain('gsd-sdk query commit "docs: start milestone v[X.Y] [Name]"');
    expect(workflow).toContain("If `phase_dir_count > 0` but `phase_archive_path` is missing");
    expect(workflow).toContain("Ask user, preferably via `interview`");
    expect(workflow).toContain("subagent start (prompt=");
  });

  it("ships complete-milestone workflow contract for audit, archive, and tag gates", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/complete-milestone.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/complete-milestone.md"),
      "utf8",
    );

    expect(command).toContain("recommend `/gsd audit-milestone` first");
    expect(command).toContain("archive to milestones/");
    expect(workflow).toContain("gsd-sdk query audit-open");
    expect(workflow).toContain("Acknowledge all — document as deferred and proceed with close");
    expect(workflow).toContain(".planning/milestones/v[X.Y]-ROADMAP.md");
    expect(workflow).toContain(".planning/milestones/v[X.Y]-REQUIREMENTS.md");
    expect(workflow).toContain('gsd-sdk query commit "chore: archive v[X.Y] milestone files"');
    expect(workflow).toContain('git tag -a v[X.Y] -m "v[X.Y] [Name]');
    expect(workflow).toContain("Archive UI artifacts (`*-UI-SPEC.md`, `*-UI-REVIEW.md`)");
    expect(loadBundledDoc("command-reference.md")).toContain(
      "local source of truth is `.planning/milestones/`; tagging should pause for explicit confirmation",
    );
  });

  it("ships secure-phase workflow contract for threat register and blocking gates", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/secure-phase.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/secure-phase.md"),
      "utf8",
    );

    expect(command).toContain(
      "bundled workflow owns security review orchestration and SECURITY.md follow-up",
    );
    expect(workflow).toContain("gsd-sdk query init.phase-op");
    expect(workflow).toContain("Build Threat Register");
    expect(workflow).toContain("register_authored_at_plan_time");
    expect(workflow).toContain("retroactive-STRIDE mode");
    expect(workflow).toContain("gsd-security-auditor");
    expect(workflow).toContain("Write/Update SECURITY.md");
    expect(workflow).toContain("threats_open > 0 BLOCKS advancement");
    expect(workflow).toContain(
      'gsd-sdk query commit "docs(phase-${PHASE}): add/update security threat verification"',
    );
    expect(loadBundledDoc("command-reference.md")).toContain(
      "workflow-owned security review builds or reuses per-phase threat register, can document accepted risks, writes `*-SECURITY.md`, and blocks advancement while threats remain open",
    );
  });

  it("keeps command reference subcommand roster aligned with registered grouped surface", () => {
    const reference = loadBundledDoc("command-reference.md");

    for (const { value } of getGsdSubcommands()) {
      expect(reference).toContain(`/gsd ${value}`);
    }
  });

  it("keeps command reference flag docs aligned with runtime autocomplete flags", () => {
    const reference = loadBundledDoc("command-reference.md");
    const flags = getGsdAutocompleteFlags();

    for (const [subcommand, values] of Object.entries(flags)) {
      if (values === undefined) {
        continue;
      }

      expect(reference).toContain(`/gsd ${subcommand}`);
      for (const value of values) {
        expect(reference).toContain(normalizeDocumentedFlag(value));
      }
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
    expect(reference).toContain(
      "flags: `--paths <repo/path,...>`, `--fast`, `--query <term|status|diff|refresh>`",
    );
    expect(reference).toContain(
      "`--focus <tech|arch|quality|concerns|tech+arch>` only with `--fast`",
    );
    expect(reference).toContain(
      "`--paths <repo/path,...>` runs scoped canonical remap with strict repo-relative path validation",
    );

    expect(flags["map-codebase"]).toBeUndefined();
    expect(reference).toContain(
      "parsed with explicit unsupported-local error: `--do`, `--forensic`",
    );
    expect(reference).toContain("narrowed local router, not full upstream `next.md` route graph");
    expect(reference).toContain(
      "unsupported upstream-equivalent branches stay manual boundaries here: paused-state resume, prior-phase deferral/backlog choices, and spike/sketch notices",
    );
    expect(reference).toContain(
      "narrowed local situational review command, not upstream routed execution hub",
    );
    expect(reference).toContain("`--phase <phase>`, `--force` only with `/gsd progress --next`");
    expect(reference).toContain(
      "unsupported upstream-equivalent branches stay fenced here: default post-report route graph, freeform `--do` dispatch, and `--forensic` integrity audit",
    );
    expect(reference).toContain(
      "Non-UI `/gsd help` emits durable `gsd-help` message output; registered local renderer is intended handling path.",
    );
    expect(reference).toContain(
      "variants: `json`, `table`, `--json`, `--table`, `--format json`, `--format table`",
    );
    expect(reference).toContain(
      "flags: `--repair`, `--backfill`, `--context`, `--tokens-used <int>`, `--tokens-used=<int>`, `--context-window <int>`, `--context-window=<int>`",
    );
    expect(reference).toContain("flags: `--text`, `--reset-phase-numbers`");
    expect(reference).toContain(
      "git statistics stay milestone-bound and the workflow must not dirty `STATE.md` as a side effect of report generation",
    );
    expect(reference).toContain(
      "`--force` only bypasses blocked/error `STATE.md` status gate; `.continue-here.md`, paused state, discuss checkpoints, and unresolved verification FAIL still stop routing",
    );
  });

  it("keeps help unsupported upstream catalog aligned with audit missing command list", () => {
    const reference = loadBundledDoc("command-reference.md");
    const audit = readFileSync(join(process.cwd(), "docs/gsd-command-coverage-audit.md"), "utf8");
    const missingSection = extractAuditSection(
      audit,
      "Missing non-namespace commands:",
      "Upstream source roster:",
    );

    for (const command of extractBacktickedValues(missingSection)) {
      expect(reference).toContain(`\`${command}\``);
    }
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

  it("keeps audit score tables aligned with per-command coverage sections", () => {
    const coverageAudit = readFileSync(
      join(process.cwd(), "docs/gsd-command-coverage-audit.md"),
      "utf8",
    );
    const completionAudit = readFileSync(join(process.cwd(), ".agent/completion-audit.md"), "utf8");

    const coverageAuditTable = extractCoverageByCommandFromAuditTable(
      extractAuditSection(coverageAudit, "Implemented locally:", "## Missing Commands"),
    );
    const coverageAuditSections = extractCoverageByCommandFromCoverageSections(coverageAudit);
    const completionAuditTable = extractCoverageByCommandFromCompletionAuditTable(completionAudit);
    const completionAuditSections = extractCoverageByCommandFromCoverageSections(completionAudit);

    for (const [command, score] of coverageAuditSections) {
      expect(coverageAuditTable.get(command)).toBe(score);
    }

    for (const [command, score] of completionAuditSections) {
      expect(completionAuditTable.get(command)).toBe(score);
    }
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
    expect(command).toContain(
      "workflow-owned diagnosis, gap-planning, and post-UAT closure guidance",
    );
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
    expect(workflow).toContain("Diagnosis And Gap-Planning Branch");
    expect(workflow).toContain("persist diagnosis via `verify-work apply-diagnosis`");
    expect(workflow).toContain("/gsd plan-phase --gaps <phase>");
    expect(workflow).toContain("Post-UAT Closure Guidance");
    expect(workflow).toContain("point to `/gsd secure-phase {phase}`");
    expect(workflow).toContain("UAT complete, security pending");
    expect(workflow).toContain("UAT complete, artifact acknowledgment pending");
    expect(workflow).toContain("Not yet supported in this slice");
    expect(workflow).toContain("Playwright/Puppeteer auto-verification branch");
    expect(workflow).toContain("MVP-mode branch via `phase.mvp-mode`");
    expect(workflow).not.toContain("auto diagnosis via `diagnose-issues.md`");
    expect(uatTemplate).toContain("status: testing | partial | complete | diagnosed");
    expect(uatTemplate).toContain("Current Test");
    expect(uatTemplate).toContain("Summary");
    expect(uatTemplate).toContain("Gaps");
    expect(uatTemplate).toContain("blocked_by");
    expect(uatTemplate).toContain("root_cause");
    expect(uatTemplate).toContain("artifacts");
    expect(uatTemplate).toContain("missing");
    expect(uatTemplate).toContain("debug_session");
    expect(loadBundledDoc("command-reference.md")).toContain(
      "workflow-owned UAT path now includes helper-backed diagnosis persistence, issue-to-gap follow-up guidance, artifact-acknowledgment/security/transition closure guidance",
    );
    expect(uatTemplate).toContain("single source of truth for verify progress");
    expect(uatTemplate).toContain("does not auto-run diagnosis, security gating, or transition");
  });

  it("keeps debug help explicit about TS-owned list/status fork and workflow handoff", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/debug.md"),
      "utf8",
    );

    expect(command).toContain("- `list` — List all active debug sessions");
    expect(command).toContain(
      "- `status <slug>` — Print full summary of a session without spawning an agent",
    );
    expect(command).toContain("- `continue <slug>` — Resume a specific session by slug");
    expect(command).toContain("gsd-debug-session-manager");
    expect(command).toContain("Check for active sessions");
    expect(command).toContain(
      "`AskUserQuestion(...)` => use `interview` for user-facing decisions and symptom intake when UI is available.",
    );
    expect(loadBundledDoc("command-reference.md")).toContain(
      "local fork is intentional: `list` and `status` are TS-rendered compact session views",
    );
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
    expect(command).toContain("workflow-owned Nyquist gap review");
    expect(command).toContain("fix-all / manual-only / cancel gate");
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
    expect(workflow).toContain("Gap review and auditor contract");
    expect(workflow).toContain("gsd-nyquist-auditor");
    expect(workflow).toContain("fix all gaps");
    expect(workflow).toContain("skip and mark manual-only");
    expect(workflow).toContain("## GAPS FILLED");
    expect(workflow).toContain(
      'git commit -m "test(phase-${PHASE}): add Nyquist validation tests"',
    );
    expect(workflow).toContain(
      'gsd-sdk query commit "docs(phase-${PHASE}): add/update validation strategy"',
    );
    expect(workflow).toContain("point to `/gsd audit-milestone`");
  });

  it("keeps plan-phase docs aligned with shipped route behavior", () => {
    const command = readFileSync(
      join(process.cwd(), "src/resources/gsd/commands/gsd/plan-phase.md"),
      "utf8",
    );
    const workflow = readFileSync(
      join(process.cwd(), "src/resources/gsd/workflows/plan-phase.md"),
      "utf8",
    );

    expect(command).toContain("- `--gaps`");
    expect(command).toContain("- `--reviews`");
    expect(command).toContain("omitted phase prefers next unplanned roadmap phase first");
    expect(command).toContain("checker-approved plans or `--skip-verify` success");
    expect(workflow).toContain("Omitted phase prefers next unplanned roadmap phase first.");
    expect(workflow).toContain("Gaps route:");
    expect(workflow).toContain(
      "Require `VERIFICATION.md` or `UAT.md` evidence before planner runs.",
    );
    expect(workflow).toContain("Reviews route:");
    expect(workflow).toContain("Require `REVIEWS.md`.");
    expect(workflow).toContain("run roadmap dependency annotation and post-planning helper");
    expect(loadBundledDoc("command-reference.md")).toContain(
      "omitted phase prefers next unplanned roadmap phase first; `--gaps` requires verification or UAT evidence and `--reviews` requires `REVIEWS.md`",
    );
  });

  it("keeps discuss-phase help explicit about TS-owned local fork", () => {
    const reference = loadBundledDoc("command-reference.md");

    expect(reference).toContain(
      "TS-owned local flow: checkpointed discuss loop, assumptions preview/artifact route, prior-context/codebase-scout loading, and phase-local blocking `.continue-here.md` gate",
    );
    expect(reference).toContain(
      "explicit local non-support: `--batch`, `--analyze`, `--power`, upstream advisor/methodology overlays, and assumptions-list artifact listing beyond preview/artifact routes",
    );
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
    expect(loadBundledDoc("command-reference.md")).toContain(
      "local slice requires explicit phase, preserves workflow-native flag pass-through, and uses bundled branch/worktree/checkpoint/regression/drift/verifier gates rather than native TS reimplementation",
    );
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
