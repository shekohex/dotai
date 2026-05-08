import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-gsd-uat-"));
}

function runJson(root: string, ...args: string[]): unknown {
  const toolPath = join(process.cwd(), "src/resources/gsd/bin/gsd-tools.cjs");
  return JSON.parse(
    execFileSync("node", [toolPath, ...args], { cwd: root, encoding: "utf8" }),
  ) as unknown;
}

function runRaw(root: string, ...args: string[]): string {
  const toolPath = join(process.cwd(), "src/resources/gsd/bin/gsd-tools.cjs");
  return execFileSync("node", [toolPath, ...args, "--raw"], { cwd: root, encoding: "utf8" });
}

function createPlanningFixture(root: string): string {
  const phaseDir = join(root, ".planning", "phases", "1-foundation");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(root, ".planning", "config.json"), "{}\n");
  writeFileSync(
    join(root, ".planning", "ROADMAP.md"),
    ["### Phase 1: Foundation", "", "**Goal**: foundation", "", "Plans:", "- [x] 1-01: done"].join(
      "\n",
    ),
  );
  return phaseDir;
}

function readText(root: string, filePath: string): string {
  return readFileSync(join(root, filePath), "utf8");
}

function writeFixtureUat(root: string): string {
  const phaseDir = createPlanningFixture(root);
  const relativePath = ".planning/phases/1-foundation/01-UAT.md";
  writeFileSync(
    join(phaseDir, "01-UAT.md"),
    [
      "---",
      "status: testing",
      "phase: 1-foundation",
      "source: 01-SUMMARY.md",
      "started: 2026-05-08T00:00:00Z",
      "updated: 2026-05-08T00:00:00Z",
      "---",
      "",
      "## Current Test",
      "",
      "number: 1",
      "name: Login works",
      "expected: Login works",
      "awaiting: user response",
      "",
      "## Tests",
      "",
      "### 1. Login works",
      "",
      "expected: Login works",
      "result: pending",
      "",
      "### 2. Layout polish",
      "",
      "expected: Layout polish",
      "result: pending",
      "",
      "## Summary",
      "",
      "total: 2",
      "passed: 0",
      "issues: 0",
      "pending: 2",
      "skipped: 0",
      "blocked: 0",
      "",
      "## Gaps",
      "",
    ].join("\n"),
  );
  return relativePath;
}

function writeFixtureSingleUat(root: string): string {
  const phaseDir = createPlanningFixture(root);
  const relativePath = ".planning/phases/1-foundation/01-UAT.md";
  writeFileSync(
    join(phaseDir, "01-UAT.md"),
    [
      "---",
      "status: testing",
      "phase: 1-foundation",
      "source: 01-SUMMARY.md",
      "started: 2026-05-08T00:00:00Z",
      "updated: 2026-05-08T00:00:00Z",
      "---",
      "",
      "## Current Test",
      "",
      "number: 1",
      "name: Login works",
      "expected: Login works",
      "awaiting: user response",
      "",
      "## Tests",
      "",
      "### 1. Login works",
      "",
      "expected: Login works",
      "result: pending",
      "",
      "## Summary",
      "",
      "total: 1",
      "passed: 0",
      "issues: 0",
      "pending: 1",
      "skipped: 0",
      "blocked: 0",
      "",
      "## Gaps",
      "",
    ].join("\n"),
  );
  return relativePath;
}

describe("uat render-checkpoint helper parity", () => {
  it("renders current checkpoint as raw output", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: testing",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "number: 1",
        "name: Happy path",
        "expected: pass shows success banner",
        "awaiting: user response",
        "",
        "## Tests",
        "",
        "### 1. Happy path",
        "",
        "expected: pass shows success banner",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const output = runRaw(root, "uat", "render-checkpoint", "--file", uatPath);
    expect(output).toContain("**Test 1: Happy path**");
    expect(output.trimStart()).toMatch(/^╔/);
  });

  it("strips protocol leak lines from current test copy", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: testing",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "number: 1",
        "name: Login",
        "expected: |",
        "  Show welcome screen",
        "  assistant to=bash: rm -rf /tmp/nope",
        "awaiting: user response",
        "",
        "## Tests",
        "",
        "### 1. Login",
        "",
        "expected: Show welcome screen",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const output = runRaw(root, "uat", "render-checkpoint", "--file", uatPath);
    expect(output).toContain("Show welcome screen");
    expect(output).not.toContain("assistant to=bash");
  });

  it("does not truncate expected text containing Z", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: testing",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "number: 1",
        "name: Last field test",
        "expected: |",
        "  Zone banner stays visible",
        "  Zebra CTA stays enabled",
        "",
        "## Tests",
        "",
        "### 1. Last field test",
        "",
        "expected: Zone banner stays visible",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const output = runRaw(root, "uat", "render-checkpoint", "--file", uatPath);
    expect(output).toContain("Zone banner stays visible");
    expect(output).toContain("Zebra CTA stays enabled");
  });

  it("parses expected block when it is last field", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: testing",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "number: 1",
        "name: Parse trailing block",
        "expected: |",
        "  Final expected line",
        "",
        "## Tests",
        "",
        "### 1. Parse trailing block",
        "",
        "expected: Final expected line",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    expect(runRaw(root, "uat", "render-checkpoint", "--file", uatPath)).toContain(
      "Final expected line",
    );
  });

  it("fails when testing is already complete", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: complete",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing complete]",
        "",
        "## Tests",
        "",
        "### 1. Done",
        "",
        "expected: done",
        "result: pass",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 1",
        "issues: 0",
        "pending: 0",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    expect(() => runRaw(root, "uat", "render-checkpoint", "--file", uatPath)).toThrow(
      /already complete/,
    );
  });
});

describe("verify-work runtime core", () => {
  it("classifies exact response tokens and severities", () => {
    const root = createRoot();
    expect(runJson(root, "verify-work", "classify", "--response", "")).toEqual({ kind: "pass" });
    expect(runJson(root, "verify-work", "classify", "--response", "yes")).toEqual({ kind: "pass" });
    expect(runJson(root, "verify-work", "classify", "--response", "next")).toEqual({
      kind: "pass",
    });
    expect(runJson(root, "verify-work", "classify", "--response", "✓")).toEqual({ kind: "pass" });
    expect(runJson(root, "verify-work", "classify", "--response", "skip")).toEqual({
      kind: "skipped",
    });
    expect(runJson(root, "verify-work", "classify", "--response", "n/a")).toEqual({
      kind: "skipped",
    });
    expect(
      runJson(root, "verify-work", "classify", "--response", "can't test - server not running"),
    ).toEqual({ kind: "blocked", blocked_by: "server" });
    expect(
      runJson(
        root,
        "verify-work",
        "classify",
        "--response",
        "can't test login because submit button is disabled",
      ),
    ).toEqual({ kind: "issue", severity: "major" });
    expect(runJson(root, "verify-work", "classify", "--response", "server not running")).toEqual({
      kind: "blocked",
      blocked_by: "server",
    });
    expect(runJson(root, "verify-work", "classify", "--response", "need physical device")).toEqual({
      kind: "blocked",
      blocked_by: "physical-device",
    });
    expect(
      runJson(root, "verify-work", "classify", "--response", "preview build unavailable"),
    ).toEqual({ kind: "blocked", blocked_by: "release-build" });
    expect(
      runJson(
        root,
        "verify-work",
        "classify",
        "--response",
        "waiting for login because button stays disabled",
      ),
    ).toEqual({ kind: "issue", severity: "major" });
    expect(runJson(root, "verify-work", "classify", "--response", "need release build")).toEqual({
      kind: "blocked",
      blocked_by: "release-build",
    });
    expect(runJson(root, "verify-work", "classify", "--response", "need spacing fix")).toEqual({
      kind: "issue",
      severity: "cosmetic",
    });
    expect(
      runJson(root, "verify-work", "classify", "--response", "blocked by Stripe config"),
    ).toEqual({ kind: "blocked", blocked_by: "third-party" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "need oauth config before testing"),
    ).toEqual({ kind: "blocked", blocked_by: "third-party" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "blocked by API gateway"),
    ).toEqual({ kind: "blocked", blocked_by: "server" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "submit button blocked by keyboard"),
    ).toEqual({ kind: "issue", severity: "major" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "reply button blocked by overlay"),
    ).toEqual({ kind: "issue", severity: "major" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "cannot test until preview build"),
    ).toEqual({ kind: "blocked", blocked_by: "release-build" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "preview build crashes on launch"),
    ).toEqual({ kind: "issue", severity: "blocker" });
    expect(
      runJson(
        root,
        "verify-work",
        "classify",
        "--response",
        "login requires double click to submit",
      ),
    ).toEqual({ kind: "issue", severity: "major" });
    expect(
      runJson(
        root,
        "verify-work",
        "classify",
        "--response",
        "search requires refresh before results appear",
      ),
    ).toEqual({ kind: "issue", severity: "major" });
    expect(
      runJson(
        root,
        "verify-work",
        "classify",
        "--response",
        "physical device keyboard covers submit button",
      ),
    ).toEqual({ kind: "issue", severity: "major" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "Stripe OAuth callback fails"),
    ).toEqual({ kind: "issue", severity: "major" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "depends on prior phase"),
    ).toEqual({ kind: "blocked", blocked_by: "prior-phase" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "depends on prerequisite migration"),
    ).toEqual({ kind: "blocked", blocked_by: "prior-phase" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "blocked by previous phase bug"),
    ).toEqual({ kind: "blocked", blocked_by: "prior-phase" });
    expect(
      runJson(root, "verify-work", "classify", "--response", "works but spacing is off"),
    ).toEqual({ kind: "issue", severity: "cosmetic" });
    expect(runJson(root, "verify-work", "classify", "--response", "works but slow")).toEqual({
      kind: "issue",
      severity: "minor",
    });
    expect(runJson(root, "verify-work", "classify", "--response", "doesn't work")).toEqual({
      kind: "issue",
      severity: "major",
    });
    expect(
      runJson(root, "verify-work", "classify", "--response", "crashes with exception"),
    ).toEqual({ kind: "issue", severity: "blocker" });
  });

  it("rejects missing classify input", () => {
    const root = createRoot();
    expect(() => runJson(root, "verify-work", "classify")).toThrow(/requires --response/i);
  });

  it("apply-response writes pass and advances current test", () => {
    const root = createRoot();
    const filePath = writeFixtureUat(root);
    const result = runJson(
      root,
      "verify-work",
      "apply-response",
      "--file",
      filePath,
      "--response",
      "pass",
    ) as { status: string; current_test: number };
    expect(result.status).toBe("partial");
    expect(result.current_test).toBe(2);
    const content = readText(root, filePath);
    expect(content).toContain("### 1. Login works");
    expect(content).toContain("result: pass");
    expect(content).toContain("number: 2");
  });

  it("apply-response writes issue gap severity and complete status", () => {
    const root = createRoot();
    const filePath = writeFixtureUat(root);
    runJson(root, "verify-work", "apply-response", "--file", filePath, "--response", "pass");
    const result = runJson(
      root,
      "verify-work",
      "apply-response",
      "--file",
      filePath,
      "--response",
      "button spacing is off",
    ) as { status: string };
    expect(result.status).toBe("complete");
    const content = readText(root, filePath);
    expect(content).toContain("result: issue");
    expect(content).toContain('reason: "User reported: button spacing is off"');
    expect(content).toContain("severity: cosmetic");
    expect(content).toContain("issues: 1");
  });

  it("apply-response writes blocked with blocked_by", () => {
    const root = createRoot();
    const filePath = writeFixtureUat(root);
    runJson(root, "verify-work", "apply-response", "--file", filePath, "--response", "pass");
    const result = runJson(
      root,
      "verify-work",
      "apply-response",
      "--file",
      filePath,
      "--response",
      "server not running",
    ) as { status: string };
    expect(result.status).toBe("partial");
    const content = readText(root, filePath);
    expect(content).toContain("result: blocked");
    expect(content).toContain("blocked_by: server");
  });

  it("apply-response writes skipped unresolved semantics", () => {
    const root = createRoot();
    const filePath = writeFixtureSingleUat(root);
    const result = runJson(
      root,
      "verify-work",
      "apply-response",
      "--file",
      filePath,
      "--response",
      "skip",
    ) as { status: string };
    expect(result.status).toBe("partial");
    const content = readText(root, filePath);
    expect(content).toContain("result: skipped");
    expect(content).not.toContain("reason:");
  });

  it("apply-response writes skipped reason semantics", () => {
    const root = createRoot();
    const filePath = writeFixtureSingleUat(root);
    const result = runJson(
      root,
      "verify-work",
      "apply-response",
      "--file",
      filePath,
      "--response",
      "can't test on simulator",
    ) as { status: string };
    expect(result.status).toBe("complete");
    const content = readText(root, filePath);
    expect(content).toContain("result: skipped");
    expect(content).toContain("reason: can't test on simulator");
  });

  it("apply-diagnosis sets diagnosed status and fields", () => {
    const root = createRoot();
    const filePath = writeFixtureSingleUat(root);
    runJson(
      root,
      "verify-work",
      "apply-response",
      "--file",
      filePath,
      "--response",
      "login broken",
    );
    const result = runJson(
      root,
      "verify-work",
      "apply-diagnosis",
      "--file",
      filePath,
      "--diagnosis",
      JSON.stringify({
        test: 1,
        root_cause: "missing auth callback",
        artifacts: [{ path: "src/auth.ts", issue: "callback not wired" }],
        missing: ["wire auth callback"],
        debug_session: ".planning/debug/auth.md",
      }),
    ) as { status: string };
    expect(result.status).toBe("diagnosed");
    const content = readText(root, filePath);
    expect(content).toContain('root_cause: "missing auth callback"');
    expect(content).toContain('path: "src/auth.ts"');
    expect(content).toContain('issue: "callback not wired"');
    expect(content).toContain('missing:\n    - "wire auth callback"');
    expect(content).toContain('debug_session: ".planning/debug/auth.md"');
  });

  it("rewrites paused current test to first unresolved item in file order", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: partial",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing paused — 2 items outstanding]",
        "",
        "## Tests",
        "",
        "### 1. Passed",
        "",
        "expected: done",
        "result: pass",
        "",
        "### 2. Blocked",
        "",
        "expected: blocked",
        "result: blocked",
        "blocked_by: server",
        "reason: waiting",
        "",
        "### 3. Resume here",
        "",
        "expected: resume this one",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 3",
        "passed: 1",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 1",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const output = runRaw(root, "uat", "render-checkpoint", "--file", uatPath);
    expect(output).toContain("**Test 2: Blocked**");
    const updated = readFileSync(uatPath, "utf8");
    expect(updated).toContain("number: 2");
    expect(updated).toContain("name: Blocked");
    expect(updated).toContain("expected: |\n  blocked\nawaiting: user response");
  });

  it("resumes first blocked test when no pending test remains", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: partial",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing paused — 1 items outstanding]",
        "",
        "## Tests",
        "",
        "### 1. Passed",
        "",
        "expected: done",
        "result: pass",
        "",
        "### 2. Blocked test",
        "",
        "expected: |",
        "  Open app",
        "  Confirm release banner",
        "result: blocked",
        "blocked_by: release-build",
        "reason: waiting for build",
        "",
        "## Summary",
        "",
        "total: 2",
        "passed: 1",
        "issues: 0",
        "pending: 0",
        "skipped: 0",
        "blocked: 1",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const output = runRaw(root, "uat", "render-checkpoint", "--file", uatPath);
    expect(output).toContain("**Test 2: Blocked test**");
    expect(output).toContain("Open app");
    expect(output).toContain("Confirm release banner");
  });

  it("resumes first unresolved test in file order", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: partial",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing paused — 2 items outstanding]",
        "",
        "## Tests",
        "",
        "### 1. Earlier skipped unresolved",
        "",
        "expected: verify earlier skipped item",
        "result: skipped",
        "",
        "### 2. Later blocked item",
        "",
        "expected: verify later blocked item",
        "result: blocked",
        "blocked_by: server",
        "reason: waiting for backend",
        "",
        "## Summary",
        "",
        "total: 2",
        "passed: 0",
        "issues: 0",
        "pending: 0",
        "skipped: 1",
        "blocked: 1",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const output = runRaw(root, "uat", "render-checkpoint", "--file", uatPath);
    expect(output).toContain("**Test 1: Earlier skipped unresolved**");
    expect(output).not.toContain("**Test 2: Later blocked item**");
  });

  it("rewrites stale numbered current test to first unresolved item", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: partial",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "number: 1",
        "name: Already passed",
        "expected: old checkpoint",
        "awaiting: user response",
        "",
        "## Tests",
        "",
        "### 1. Already passed",
        "",
        "expected: old checkpoint",
        "result: pass",
        "",
        "### 2. Real unresolved",
        "",
        "expected: real expected",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 2",
        "passed: 1",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const output = runRaw(root, "uat", "render-checkpoint", "--file", uatPath);
    expect(output).toContain("**Test 2: Real unresolved**");
    const updated = readFileSync(uatPath, "utf8");
    expect(updated).toContain("number: 2");
    expect(updated).toContain("name: Real unresolved");
  });

  it("preserves multi-line expectations when resuming checkpoints", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: partial",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing paused — 1 items outstanding]",
        "",
        "## Tests",
        "",
        "### 1. Multi-line pending",
        "",
        "expected: |",
        "  Step one visible",
        "  Step two visible",
        "  Step three visible",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const output = runRaw(root, "uat", "render-checkpoint", "--file", uatPath);
    expect(output).toContain("Step one visible");
    expect(output).toContain("Step two visible");
    expect(output).toContain("Step three visible");
  });

  it("complete file does not attempt checkpoint render", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: partial",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing paused — 0 items outstanding]",
        "",
        "## Tests",
        "",
        "### 1. Passed",
        "",
        "expected: done",
        "result: pass",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 1",
        "issues: 0",
        "pending: 0",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    expect(() => runRaw(root, "uat", "render-checkpoint", "--file", uatPath)).toThrow(
      /already complete/,
    );
  });

  it("computes completion semantics", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const makeFile = (body: string) => {
      const path = join(phaseDir, "01-UAT.md");
      writeFileSync(path, body);
      return path;
    };

    const completePath = makeFile(
      [
        "---",
        "status: testing",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing complete]",
        "",
        "## Tests",
        "",
        "### 1. Pass",
        "",
        "expected: ok",
        "result: pass",
        "",
        "### 2. Issue",
        "",
        "expected: ok",
        "result: issue",
        'reported: "bad"',
        "severity: major",
        "",
        "### 3. Skip",
        "",
        "expected: ok",
        "result: skipped",
        "reason: unsupported env",
        "",
        "## Summary",
        "",
        "total: 3",
        "passed: 1",
        "issues: 1",
        "pending: 0",
        "skipped: 1",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );
    expect(runJson(root, "verify-work", "status", "--file", completePath)).toEqual({
      status: "complete",
      counts: { total: 3, passed: 1, issues: 1, pending: 0, skipped: 1, blocked: 0 },
    });

    const pendingPath = makeFile(
      readFileSync(completePath, "utf8").replace("result: issue", "result: [pending]"),
    );
    expect(
      (runJson(root, "verify-work", "status", "--file", pendingPath) as { status: string }).status,
    ).toBe("partial");

    const blockedPath = makeFile(
      readFileSync(completePath, "utf8").replace(
        "result: issue",
        "result: blocked\nblocked_by: server\nreason: wait",
      ),
    );
    expect(
      (runJson(root, "verify-work", "status", "--file", blockedPath) as { status: string }).status,
    ).toBe("partial");

    const skippedNoReasonPath = makeFile(
      readFileSync(completePath, "utf8").replace("reason: unsupported env", ""),
    );
    expect(
      (runJson(root, "verify-work", "status", "--file", skippedNoReasonPath) as { status: string })
        .status,
    ).toBe("partial");
  });

  it("preserves diagnosed status authority in status helper", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const filePath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      filePath,
      [
        "---",
        "status: diagnosed",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing complete]",
        "",
        "## Tests",
        "",
        "### 1. Broken login",
        "",
        "expected: login works",
        "result: issue",
        'reported: "login broken"',
        "severity: major",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 1",
        "pending: 0",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
        '- truth: "login works"',
        "  status: failed",
        '  reason: "User reported: login broken"',
        "  severity: major",
        "  test: 1",
        '  root_cause: "missing callback"',
        "  artifacts: []",
        "  missing: []",
        '  debug_session: ""',
      ].join("\n"),
    );

    expect(runJson(root, "verify-work", "status", "--file", filePath)).toEqual({
      status: "diagnosed",
      counts: { total: 1, passed: 0, issues: 1, pending: 0, skipped: 0, blocked: 0 },
    });
  });

  it("rejects status for missing or malformed parsed tests", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const missingTestsPath = join(phaseDir, "01-UAT.md");
    writeFileSync(
      missingTestsPath,
      [
        "---",
        "status: testing",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "number: 1",
        "name: Broken",
        "expected: broken",
        "awaiting: user response",
        "",
        "## Summary",
        "",
        "total: 0",
        "passed: 0",
        "issues: 0",
        "pending: 0",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );
    expect(() => runJson(root, "verify-work", "status", "--file", missingTestsPath)).toThrow(
      /missing parseable Tests entries/i,
    );

    const malformedTestsPath = join(phaseDir, "02-UAT.md");
    writeFileSync(
      malformedTestsPath,
      [
        "---",
        "status: testing",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "number: 1",
        "name: Broken",
        "expected: broken",
        "awaiting: user response",
        "",
        "## Tests",
        "",
        "### 1. Broken",
        "",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );
    expect(() => runJson(root, "verify-work", "status", "--file", malformedTestsPath)).toThrow(
      /missing parseable Tests entries/i,
    );
  });

  it("handles session progression and artifact creation", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const noArgsNoSession = runJson(root, "verify-work", "session") as {
      action: string;
      prompt: string;
      phases: Array<{ phase: string; phase_dir: string; summary_files: string[] }>;
    };
    expect(noArgsNoSession).toEqual({
      action: "prompt-phase",
      prompt: "Enter phase number to start verify-work.",
      phases: [],
    });

    writeFileSync(
      join(phaseDir, "01-SUMMARY.md"),
      [
        "---",
        "key-files:",
        "  created:",
        "    - src/app.tsx",
        "  modified:",
        "    - src/auth.ts",
        "---",
        "# Phase 1: Foundation Summary",
        "",
        "**app shell delivered**",
        "",
        "## Accomplishments",
        "",
        "- internal-only: refactor helper naming",
        "- User can sign in successfully",
        "- Dashboard loads after login",
      ].join("\n"),
    );

    const explicitNoUat = runJson(root, "verify-work", "session", "--phase", "1") as {
      action: string;
    };
    expect(explicitNoUat.action).toBe("bootstrap-new");

    const created = runJson(root, "verify-work", "create", "--phase", "1") as {
      action: string;
      file_path: string;
      counts: { blocked: number; total: number };
    };
    expect(created.action).toBe("created");
    expect(created.counts.blocked).toBe(0);
    expect(created.counts.total).toBe(3);

    const createdContent = readFileSync(join(root, created.file_path), "utf8");
    expect(createdContent).toContain("### 1. Cold start smoke test");
    expect(createdContent).not.toContain("internal-only: refactor helper naming");
    expect(createdContent).toContain("blocked: 0");

    const noArgsOneSession = runJson(root, "verify-work", "session") as {
      action: string;
      prompt: string;
      sessions: Array<{ file_path: string }>;
    };
    expect(noArgsOneSession.action).toBe("choose-session-or-phase");
    expect(noArgsOneSession.prompt).toContain("Choose session number");
    expect(noArgsOneSession.sessions).toHaveLength(1);
    expect(noArgsOneSession).toMatchObject({
      phases: [
        {
          phase: "1",
          phase_dir: ".planning/phases/1-foundation",
          summary_files: ["01-SUMMARY.md"],
        },
      ],
    });

    const explicitExisting = runJson(root, "verify-work", "session", "--phase", "1") as {
      action: string;
      file_path: string;
    };
    expect(explicitExisting.action).toBe("resume-or-restart");
    expect(explicitExisting.file_path).toContain("01-UAT.md");
  });

  it("bootstraps from user-facing changes section", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-SUMMARY.md"),
      [
        "# Phase 1: Foundation Summary",
        "",
        "## User-Facing Changes",
        "",
        "- User can sign in with email and password",
        "- Dashboard shows recent activity after login",
      ].join("\n"),
    );

    const created = runJson(root, "verify-work", "create", "--phase", "1") as {
      action: string;
      file_path: string;
      counts: { total: number };
    };
    expect(created.action).toBe("created");
    expect(created.counts.total).toBe(2);
    const content = readFileSync(join(root, created.file_path), "utf8");
    expect(content).toContain("User can sign in with email and password");
    expect(content).toContain("Dashboard shows recent activity after login");
  });

  it("does not advertise bootstrap when phase directory is missing", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "### Phase 1: Foundation",
        "",
        "**Goal**: foundation",
        "",
        "Plans:",
        "- [ ] 1-01: pending",
      ].join("\n"),
    );

    const result = runJson(root, "verify-work", "session", "--phase", "1") as {
      action: string;
      phase: string;
      phase_name: string;
      prompt: string;
    };
    expect(result).toEqual({
      action: "missing-phase-dir",
      phase: "1",
      phase_name: "Foundation",
      prompt: "Phase exists in ROADMAP but no phase directory exists yet.",
    });
  });

  it("lists candidate phases when no active session exists", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-SUMMARY.md"),
      [
        "# Phase 1: Foundation Summary",
        "",
        "## Accomplishments",
        "",
        "- User can sign in successfully",
      ].join("\n"),
    );

    const result = runJson(root, "verify-work", "session") as {
      action: string;
      phases: Array<{ phase: string; phase_dir: string; summary_files: string[] }>;
    };
    expect(result.action).toBe("prompt-phase");
    expect(result.phases).toEqual([
      {
        phase: "1",
        phase_dir: ".planning/phases/1-foundation",
        summary_files: ["01-SUMMARY.md"],
      },
    ]);
  });

  it("rejects empty UAT artifact creation when no observable tests remain", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-SUMMARY.md"),
      [
        "# Phase 1: Foundation Summary",
        "",
        "**internal-only: maintenance pass**",
        "",
        "## Accomplishments",
        "",
        "- internal-only: rename helper",
        "- internal-only: reorder imports",
      ].join("\n"),
    );

    expect(() => runJson(root, "verify-work", "create", "--phase", "1")).toThrow(
      /no user-observable tests/i,
    );
  });

  it("adds cold-start smoke test for migration seed and startup-only summaries", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-SUMMARY.md"),
      [
        "---",
        "key-files:",
        "  created:",
        "    - database/schema.sql",
        "    - seeds/dev-seed.ts",
        "  modified:",
        "    - migrations/001_init.sql",
        "    - startup-check.ts",
        "---",
        "# Phase 1: Foundation Summary",
        "",
        "**data bootstrapping delivered**",
        "",
        "## Accomplishments",
        "",
        "- Seed local data",
        "- Run startup checks",
      ].join("\n"),
    );

    const created = runJson(root, "verify-work", "create", "--phase", "1") as {
      file_path: string;
      counts: { total: number };
    };

    const createdContent = readFileSync(join(root, created.file_path), "utf8");
    expect(createdContent).toContain("### 1. Cold start smoke test");
    expect(created.counts.total).toBe(3);
  });

  it("audit-uat finds unresolved exact-name UAT sessions with block expected values", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    const uatPath = join(phaseDir, "UAT.md");
    writeFileSync(
      uatPath,
      [
        "---",
        "status: partial",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing paused — 2 items outstanding]",
        "",
        "## Tests",
        "",
        "### 1. Pending multiline",
        "",
        "expected: |",
        "  Open app",
        "  Observe seeded content",
        "result: [pending]",
        "",
        "### 2. Blocked multiline",
        "",
        "expected: |",
        "  Open preview build",
        "  Confirm login",
        "result: blocked",
        "blocked_by: release-build",
        "reason: waiting for preview",
        "",
        "## Summary",
        "",
        "total: 2",
        "passed: 0",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 1",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const result = runJson(root, "audit-uat") as {
      results: Array<{ file: string; items: Array<{ expected: string; result: string }> }>;
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.file).toBe("UAT.md");
    expect(result.results[0]?.items).toEqual([
      expect.objectContaining({ expected: "Open app\nObserve seeded content", result: "pending" }),
      expect.objectContaining({ expected: "Open preview build\nConfirm login", result: "blocked" }),
    ]);
  });

  it("audit-uat does not surface resolved skips as open debt", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-UAT.md"),
      [
        "---",
        "status: complete",
        "phase: 1-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing complete]",
        "",
        "## Tests",
        "",
        "### 1. Resolved skip",
        "",
        "expected: optional path",
        "result: skipped",
        "reason: unsupported in local dev",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 0",
        "pending: 0",
        "skipped: 1",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const result = runJson(root, "audit-uat") as {
      results: unknown[];
      summary: { total_items: number };
    };
    expect(result.results).toHaveLength(0);
    expect(result.summary.total_items).toBe(0);
  });

  it("audit-uat parses human_verification frontmatter debt", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-VERIFICATION.md"),
      [
        "---",
        "status: human_needed",
        "human_verification:",
        "  - test: 1",
        '    name: "Verify onboarding on real device"',
        "    result: pending",
        "  - test: 2",
        '    name: "Resolved row"',
        "    result: resolved",
        "---",
        "",
        "# Verification",
      ].join("\n"),
    );

    const result = runJson(root, "audit-uat") as {
      results: Array<{
        type: string;
        items: Array<{ test?: number; name: string; result: string }>;
      }>;
      summary: { total_items: number };
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.type).toBe("verification");
    expect(result.results[0]?.items).toEqual([
      expect.objectContaining({
        test: 1,
        name: "Verify onboarding on real device",
        result: "human_needed",
      }),
    ]);
    expect(result.summary.total_items).toBe(1);
  });

  it("audit-uat accepts upstream human_verification.test text shape", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-VERIFICATION.md"),
      [
        "---",
        "status: human_needed",
        "human_verification:",
        '  - test: "Verify login works on real iPhone"',
        '    expected: "Login succeeds and lands on dashboard"',
        '    why_human: "Needs real-device keyboard behavior"',
        "    result: pending",
        "---",
        "",
        "# Verification",
      ].join("\n"),
    );

    const result = runJson(root, "audit-uat") as {
      results: Array<{
        type: string;
        items: Array<{ name: string; result: string; expected?: string; why_human?: string }>;
      }>;
      summary: { total_items: number };
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.type).toBe("verification");
    expect(result.results[0]?.items).toEqual([
      expect.objectContaining({
        name: "Verify login works on real iPhone",
        result: "human_needed",
        expected: "Login succeeds and lands on dashboard",
        why_human: "Needs real-device keyboard behavior",
      }),
    ]);
    expect(result.summary.total_items).toBe(1);
  });

  it("audit-uat deduplicates human_verification frontmatter and body items", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-VERIFICATION.md"),
      [
        "---",
        "status: human_needed",
        "human_verification:",
        "  - test: 1",
        '    name: "Verify onboarding on real device"',
        "    result: pending",
        "---",
        "",
        "## Human Verification",
        "",
        "1. Verify onboarding on real device",
      ].join("\n"),
    );

    const result = runJson(root, "audit-uat") as {
      results: Array<{ items: Array<{ test?: number; name: string }> }>;
      summary: { total_items: number };
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.items).toHaveLength(1);
    expect(result.results[0]?.items[0]).toEqual(
      expect.objectContaining({ test: 1, name: "Verify onboarding on real device" }),
    );
    expect(result.summary.total_items).toBe(1);
  });

  it("audit-uat parses underscore human_verification headings", () => {
    const root = createRoot();
    const phaseDir = createPlanningFixture(root);
    writeFileSync(
      join(phaseDir, "01-VERIFICATION.md"),
      [
        "---",
        "status: human_needed",
        "---",
        "",
        "## human_verification (manual follow-up)",
        "",
        "1. Verify magic-link login on Safari",
      ].join("\n"),
    );

    const result = runJson(root, "audit-uat") as {
      results: Array<{
        type: string;
        items: Array<{ test?: number; name: string; result: string }>;
      }>;
      summary: { total_items: number };
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.type).toBe("verification");
    expect(result.results[0]?.items).toEqual([
      expect.objectContaining({
        test: 1,
        name: "Verify magic-link login on Safari",
        result: "human_needed",
      }),
    ]);
    expect(result.summary.total_items).toBe(1);
  });

  it("lists multiple active sessions", () => {
    const root = createRoot();
    const phaseOneDir = createPlanningFixture(root);
    const phaseTwoDir = join(root, ".planning", "phases", "2-delivery");
    mkdirSync(phaseTwoDir, { recursive: true });
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "### Phase 1: Foundation",
        "",
        "**Goal**: foundation",
        "",
        "Plans:",
        "- [x] 1-01: done",
        "",
        "### Phase 2: Delivery",
        "",
        "**Goal**: delivery",
        "",
        "Plans:",
        "- [x] 2-01: done",
      ].join("\n"),
    );
    const uatBody = [
      "---",
      "status: partial",
      "phase: 1-foundation",
      "source: 01-SUMMARY.md",
      "started: 2026-05-08T00:00:00Z",
      "updated: 2026-05-08T00:00:00Z",
      "---",
      "",
      "## Current Test",
      "",
      "[testing paused — 1 items outstanding]",
      "",
      "## Tests",
      "",
      "### 1. Pending",
      "",
      "expected: ok",
      "result: [pending]",
      "",
      "## Summary",
      "",
      "total: 1",
      "passed: 0",
      "issues: 0",
      "pending: 1",
      "skipped: 0",
      "blocked: 0",
      "",
      "## Gaps",
      "",
    ].join("\n");
    writeFileSync(join(phaseOneDir, "01-UAT.md"), uatBody);
    writeFileSync(join(phaseTwoDir, "02-UAT.md"), uatBody.replace(/1-foundation/g, "2-delivery"));

    const result = runJson(root, "verify-work", "session") as {
      action: string;
      sessions: unknown[];
      phases: Array<{ phase: string; phase_dir: string; summary_files: string[] }>;
    };
    expect(result.action).toBe("choose-session-or-phase");
    expect(result.sessions).toHaveLength(2);
    expect(result.phases).toEqual([]);
  });

  it("normalizes prefixed phase ids in session discovery payloads", () => {
    const root = createRoot();
    const prefixedPhaseDir = join(root, ".planning", "phases", "APP-01-foundation");
    mkdirSync(prefixedPhaseDir, { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), '{"project_code":"APP"}\n');
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "### Phase 1: Foundation",
        "",
        "**Goal**: foundation",
        "",
        "Plans:",
        "- [ ] 1-01: ship",
      ].join("\n"),
    );
    writeFileSync(
      join(prefixedPhaseDir, "01-SUMMARY.md"),
      ["# Phase 1: Foundation Summary", "", "## Accomplishments", "", "- User can sign in"].join(
        "\n",
      ),
    );

    const promptResult = runJson(root, "verify-work", "session") as {
      action: string;
      phases: Array<{ phase: string; phase_dir: string; summary_files: string[] }>;
    };
    expect(promptResult.action).toBe("prompt-phase");
    expect(promptResult.phases).toEqual([
      {
        phase: "1",
        phase_dir: ".planning/phases/APP-01-foundation",
        summary_files: ["01-SUMMARY.md"],
      },
    ]);

    writeFileSync(
      join(prefixedPhaseDir, "01-UAT.md"),
      [
        "---",
        "status: partial",
        "phase: APP-01-foundation",
        "source: 01-SUMMARY.md",
        "started: 2026-05-08T00:00:00Z",
        "updated: 2026-05-08T00:00:00Z",
        "---",
        "",
        "## Current Test",
        "",
        "[testing paused — 1 items outstanding]",
        "",
        "## Tests",
        "",
        "### 1. Pending",
        "",
        "expected: ok",
        "result: [pending]",
        "",
        "## Summary",
        "",
        "total: 1",
        "passed: 0",
        "issues: 0",
        "pending: 1",
        "skipped: 0",
        "blocked: 0",
        "",
        "## Gaps",
        "",
      ].join("\n"),
    );

    const sessionResult = runJson(root, "verify-work", "session") as {
      action: string;
      sessions: Array<{ phase: string; phase_dir: string; file_path: string }>;
      phases: Array<{ phase: string }>;
    };
    expect(sessionResult.action).toBe("choose-session-or-phase");
    expect(sessionResult.sessions).toHaveLength(1);
    expect(sessionResult.sessions[0]).toMatchObject({
      phase: "1",
      phase_dir: ".planning/phases/APP-01-foundation",
      file_path: ".planning/phases/APP-01-foundation/01-UAT.md",
    });
    expect(sessionResult.phases).toEqual([
      {
        phase: "1",
        phase_dir: ".planning/phases/APP-01-foundation",
        summary_files: ["01-SUMMARY.md"],
      },
    ]);
  });

  it("does not reuse archived phase directory when current roadmap phase has no directory", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "1-archived-foundation"), { recursive: true });
    mkdirSync(join(root, ".planning", "milestones", "v0.1-phases", "1-archived-foundation"), {
      recursive: true,
    });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "### Phase 1: Current Foundation",
        "",
        "**Goal**: current",
        "",
        "Plans:",
        "- [ ] 1-01: ship",
      ].join("\n"),
    );
    writeFileSync(
      join(root, ".planning", "phases", "1-archived-foundation", "01-SUMMARY.md"),
      ["# Archived Summary", "", "## Accomplishments", "", "- Archived user flow"].join("\n"),
    );
    writeFileSync(
      join(
        root,
        ".planning",
        "milestones",
        "v0.1-phases",
        "1-archived-foundation",
        "01-SUMMARY.md",
      ),
      ["# Archived Summary", "", "## Accomplishments", "", "- Archived user flow"].join("\n"),
    );

    const sessionResult = runJson(root, "verify-work", "session", "--phase", "1") as {
      action: string;
      phase: string;
      phase_name: string;
      prompt: string;
    };
    expect(sessionResult).toEqual({
      action: "missing-phase-dir",
      phase: "1",
      phase_name: "Current Foundation",
      prompt: "Phase exists in ROADMAP but no phase directory exists yet.",
    });

    expect(() => runJson(root, "verify-work", "create", "--phase", "1")).toThrow(
      /Phase 1 directory not found for verify-work/,
    );
  });
});
