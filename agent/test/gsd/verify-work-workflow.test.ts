import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolvePhaseDir } from "../../src/resources/gsd/bin/lib/verify-work.cjs";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

function createRoot(): string {
  return createTempDirSync("agent-gsd-verify-work-");
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

function createRoadmapFallbackFixture(root: string): void {
  mkdirSync(join(root, ".planning"), { recursive: true });
  writeFileSync(join(root, ".planning", "config.json"), "{}\n");
  writeFileSync(
    join(root, ".planning", "ROADMAP.md"),
    ["### Phase 1: Foundation", "", "**Goal**: foundation", "", "Plans:", "- [ ] 1-01: ship"].join(
      "\n",
    ),
  );
}

function createArchivedMilestoneGuardFixture(root: string): void {
  mkdirSync(join(root, ".planning", "phases", "1-old-archive"), { recursive: true });
  mkdirSync(join(root, ".planning", "milestones", "v0.1-phases", "1-old-archive"), {
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
  writeFileSync(join(root, ".planning", "phases", "1-old-archive", "01-SUMMARY.md"), "# old\n");
  writeFileSync(
    join(root, ".planning", "milestones", "v0.1-phases", "1-old-archive", "01-SUMMARY.md"),
    "# archived\n",
  );
}

function createStalePaddedPhaseFixture(root: string): void {
  mkdirSync(join(root, ".planning", "phases", "01-old-foundation"), { recursive: true });
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
    join(root, ".planning", "phases", "01-old-foundation", "01-01-SUMMARY.md"),
    "# old\n",
  );
}

function createMatchingPaddedPhaseFixture(root: string): void {
  mkdirSync(join(root, ".planning", "phases", "01-current-foundation"), { recursive: true });
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
    join(root, ".planning", "phases", "01-current-foundation", "01-01-SUMMARY.md"),
    ["# Summary", "", "## Tests", "", "### 1. Happy path", "expected: app works", ""].join("\n"),
  );
}

function createMatchingPrefixedPhaseFixture(root: string): void {
  mkdirSync(join(root, ".planning", "phases", "APP-01-current-foundation"), {
    recursive: true,
  });
  writeFileSync(join(root, ".planning", "config.json"), '{"project_code":"APP"}\n');
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
    join(root, ".planning", "phases", "APP-01-current-foundation", "01-01-SUMMARY.md"),
    ["# Summary", "", "## Tests", "", "### 1. Happy path", "expected: app works", ""].join("\n"),
  );
}

function createMixedStaleAndValidPrefixedPhaseFixture(root: string): void {
  mkdirSync(join(root, ".planning", "phases", "01-old-foundation"), { recursive: true });
  mkdirSync(join(root, ".planning", "phases", "APP-01-current-foundation"), {
    recursive: true,
  });
  writeFileSync(join(root, ".planning", "config.json"), '{"project_code":"APP"}\n');
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
    join(root, ".planning", "phases", "01-old-foundation", "01-01-SUMMARY.md"),
    "# old\n",
  );
  writeFileSync(
    join(root, ".planning", "phases", "APP-01-current-foundation", "01-01-SUMMARY.md"),
    ["# Summary", "", "## Tests", "", "### 1. Happy path", "expected: app works", ""].join("\n"),
  );
}

describe("verify-work workflow contracts", () => {
  it("preserves init verify-work roadmap fallback semantics", () => {
    const root = createRoot();
    createRoadmapFallbackFixture(root);

    const result = runTool(root, "init", "verify-work", "1") as {
      phase_found: boolean;
      phase_dir: string | null;
      phase_dir_fallback_allowed: boolean;
      phase_number: string | null;
      phase_name: string | null;
    };

    expect(result.phase_found).toBe(true);
    expect(result.phase_dir).toBeNull();
    expect(result.phase_dir_fallback_allowed).toBe(true);
    expect(result.phase_number).toBe("1");
    expect(result.phase_name).toBe("Foundation");
  });

  it("preserves init verify-work archived milestone guard semantics", () => {
    const root = createRoot();
    createArchivedMilestoneGuardFixture(root);

    const result = runTool(root, "init", "verify-work", "1") as {
      phase_found: boolean;
      phase_dir: string | null;
      phase_name: string | null;
    };

    expect(result.phase_found).toBe(true);
    expect(result.phase_dir).toBeNull();
    expect(result.phase_name).toBe("Current Foundation");
  });

  it("does not scan fallback phase dirs without explicit init approval", () => {
    const root = createRoot();
    createArchivedMilestoneGuardFixture(root);

    expect(
      resolvePhaseDir(root, "1", {
        phase_dir: null,
        phase_number: "1",
        phase_name: "Current Foundation",
      }),
    ).toBeNull();
  });

  it("still scans fallback phase dirs when init explicitly approves", () => {
    const root = createRoot();
    createArchivedMilestoneGuardFixture(root);

    expect(
      resolvePhaseDir(root, "1", {
        phase_dir: null,
        phase_dir_fallback_allowed: true,
        phase_number: "1",
        phase_name: "old archive",
      }),
    ).toBe(join(root, ".planning", "phases", "1-old-archive"));
  });

  it("rejects stale padded current phase dir when roadmap slug changed", () => {
    const root = createRoot();
    createStalePaddedPhaseFixture(root);

    const result = runTool(root, "init", "verify-work", "1") as {
      phase_found: boolean;
      phase_dir: string | null;
      phase_dir_fallback_allowed: boolean;
      phase_name: string | null;
    };

    expect(result.phase_found).toBe(true);
    expect(result.phase_dir).toBeNull();
    expect(result.phase_dir_fallback_allowed).toBe(false);
    expect(result.phase_name).toBe("Current Foundation");
  });

  it("preserves matching padded current phase dir", () => {
    const root = createRoot();
    createMatchingPaddedPhaseFixture(root);

    const result = runTool(root, "init", "verify-work", "1") as {
      phase_found: boolean;
      phase_dir: string | null;
      phase_dir_fallback_allowed: boolean;
    };

    expect(result.phase_found).toBe(true);
    expect(result.phase_dir).toBe(".planning/phases/01-current-foundation");
    expect(result.phase_dir_fallback_allowed).toBe(true);
  });

  it("preserves matching project-prefixed current phase dir", () => {
    const root = createRoot();
    createMatchingPrefixedPhaseFixture(root);

    const result = runTool(root, "init", "verify-work", "1") as {
      phase_found: boolean;
      phase_dir: string | null;
      phase_dir_fallback_allowed: boolean;
    };

    expect(result.phase_found).toBe(true);
    expect(result.phase_dir).toBe(".planning/phases/APP-01-current-foundation");
    expect(result.phase_dir_fallback_allowed).toBe(true);
  });

  it("verify-work fallback prefers valid prefixed current dir over stale numeric dir", () => {
    const root = createRoot();
    createMixedStaleAndValidPrefixedPhaseFixture(root);

    const result = runTool(root, "verify-work", "session", "--phase", "1") as {
      action: string;
      phase: string;
      phase_name: string;
    };

    expect(result).toEqual({
      action: "bootstrap-new",
      phase: "1",
      phase_name: "Current Foundation",
    });

    expect(
      resolvePhaseDir(root, "1", {
        phase_dir: null,
        phase_dir_fallback_allowed: true,
        phase_number: "1",
        phase_name: "Current Foundation",
      }),
    ).toBe(join(root, ".planning", "phases", "APP-01-current-foundation"));
  });

  it("verify-work session does not bootstrap stale padded current dir", () => {
    const root = createRoot();
    createStalePaddedPhaseFixture(root);

    const result = runTool(root, "verify-work", "session", "--phase", "1") as {
      action: string;
      phase: string;
      phase_name: string;
      prompt: string;
    };

    expect(result).toEqual({
      action: "missing-phase-dir",
      phase: "1",
      phase_name: "Current Foundation",
      prompt: "Phase exists in ROADMAP but no phase directory exists yet.",
    });
  });

  it("verify-work create does not create UAT in stale padded current dir", () => {
    const root = createRoot();
    createStalePaddedPhaseFixture(root);

    expect(() => runTool(root, "verify-work", "create", "--phase", "1")).toThrowError(
      /Phase 1 directory not found for verify-work/,
    );
  });

  it("keeps UAT template contract fields for authoritative progress artifact", () => {
    const template = readFileSync(
      join(process.cwd(), "src/resources/gsd/templates/UAT.md"),
      "utf8",
    );

    expect(template).toContain("status: testing | partial | complete | diagnosed");
    expect(template).toContain("phase: XX-name");
    expect(template).toContain("source: [list of SUMMARY.md files tested]");
    expect(template).toContain("started: [ISO timestamp]");
    expect(template).toContain("updated: [ISO timestamp]");
    expect(template).toContain("## Current Test");
    expect(template).toContain("## Summary");
    expect(template).toContain("## Gaps");
    expect(template).toContain("blocked_by:");
    expect(template).toContain("root_cause:");
    expect(template).toContain("artifacts:");
    expect(template).toContain("missing:");
    expect(template).toContain("debug_session:");
    expect(template).toContain("does not auto-run diagnosis, security gating, or transition");
  });
});
