import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-gsd-validate-phase-"));
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

describe("validate-phase workflow contracts", () => {
  it("init validate-phase reports ready completed phase with deterministic artifact paths", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "### Phase 2: Build",
        "",
        "**Goal**: Ship feature",
        "**Requirements**: [REQ-2, REQ-3]",
        "",
        "Plans:",
        "- [ ] 02-01: Implement feature",
        "- [ ] 02-02: Finish feature",
      ].join("\n"),
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-02-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-VERIFICATION.md"),
      "# Verification\n",
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-UAT.md"), "# UAT\n");

    const result = runTool(root, "init", "validate-phase", "2") as {
      ready: boolean;
      failure_reason: string | null;
      phase_goal: string | null;
      phase_requirements: string[];
      summary_count: number;
      verification_count: number;
      uat_count: number;
      validation_path: string | null;
      validation_target_path: string | null;
      validation_target_mode: string | null;
      summary_paths: string[];
    };

    expect(result.ready).toBe(true);
    expect(result.failure_reason).toBeNull();
    expect(result.phase_goal).toBe("Ship feature");
    expect(result.phase_requirements).toEqual(["REQ-2", "REQ-3"]);
    expect(result.summary_count).toBe(2);
    expect(result.verification_count).toBe(1);
    expect(result.uat_count).toBe(1);
    expect(result.validation_path).toBe(".planning/phases/2-build/02-VALIDATION.md");
    expect(result.validation_target_path).toBe(".planning/phases/2-build/02-VALIDATION.md");
    expect(result.validation_target_mode).toBe("create");
    expect(result.summary_paths).toEqual([
      ".planning/phases/2-build/02-01-SUMMARY.md",
      ".planning/phases/2-build/02-02-SUMMARY.md",
    ]);
  });

  it("init validate-phase reports update target for canonical existing validation artifact", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      ["### Phase 2: Build", "", "Plans:", "- [ ] 02-01: Implement feature"].join("\n"),
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-VALIDATION.md"),
      "# Validation\n",
    );

    const result = runTool(root, "init", "validate-phase", "2") as {
      ready: boolean;
      failure_reason: string | null;
      validation_exists: boolean;
      validation_target_path: string | null;
      validation_target_mode: string | null;
    };

    expect(result.ready).toBe(true);
    expect(result.failure_reason).toBeNull();
    expect(result.validation_exists).toBe(true);
    expect(result.validation_target_path).toBe(".planning/phases/2-build/02-VALIDATION.md");
    expect(result.validation_target_mode).toBe("update");
  });

  it("init validate-phase fails closed for ambiguous validation artifacts", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      ["### Phase 2: Build", "", "Plans:", "- [ ] 02-01: Implement feature"].join("\n"),
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-VALIDATION.md"),
      "# Validation\n",
    );
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-extra-VALIDATION.md"),
      "# Validation\n",
    );

    const result = runTool(root, "init", "validate-phase", "2") as {
      ready: boolean;
      failure_reason: string | null;
      validation_exists: boolean;
      validation_path: string | null;
      validation_target_path: string | null;
      validation_target_mode: string | null;
    };

    expect(result.ready).toBe(false);
    expect(result.failure_reason).toBe(
      "phase 02 has ambiguous or non-canonical VALIDATION.md artifacts",
    );
    expect(result.validation_exists).toBe(true);
    expect(result.validation_path).toBeNull();
    expect(result.validation_target_path).toBeNull();
    expect(result.validation_target_mode).toBeNull();
  });

  it("init validate-phase fails closed for non-canonical validation artifact", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      ["### Phase 2: Build", "", "Plans:", "- [ ] 02-01: Implement feature"].join("\n"),
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "build-VALIDATION.md"),
      "# Validation\n",
    );

    const result = runTool(root, "init", "validate-phase", "2") as {
      ready: boolean;
      failure_reason: string | null;
      validation_exists: boolean;
      validation_path: string | null;
      validation_target_path: string | null;
      validation_target_mode: string | null;
    };

    expect(result.ready).toBe(false);
    expect(result.failure_reason).toBe(
      "phase 02 has ambiguous or non-canonical VALIDATION.md artifacts",
    );
    expect(result.validation_exists).toBe(true);
    expect(result.validation_path).toBeNull();
    expect(result.validation_target_path).toBeNull();
    expect(result.validation_target_mode).toBeNull();
  });

  it("init validate-phase fails closed for lowercase validation artifact variant", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      ["### Phase 2: Build", "", "Plans:", "- [ ] 02-01: Implement feature"].join("\n"),
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(
      join(root, ".planning", "phases", "2-build", "02-validation.md"),
      "# Validation\n",
    );

    const result = runTool(root, "init", "validate-phase", "2") as {
      ready: boolean;
      failure_reason: string | null;
      validation_count: number;
      validation_exists: boolean;
      validation_path: string | null;
      validation_target_path: string | null;
      validation_target_mode: string | null;
    };

    expect(result.ready).toBe(false);
    expect(result.failure_reason).toBe(
      "phase 02 has ambiguous or non-canonical VALIDATION.md artifacts",
    );
    expect(result.validation_count).toBe(1);
    expect(result.validation_exists).toBe(true);
    expect(result.validation_path).toBeNull();
    expect(result.validation_target_path).toBeNull();
    expect(result.validation_target_mode).toBeNull();
  });

  it("init validate-phase fails closed for incomplete phase", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "### Phase 2: Build",
        "",
        "**Goal**: Ship feature",
        "",
        "Plans:",
        "- [ ] 02-01: Implement feature",
        "- [ ] 02-02: Finish feature",
      ].join("\n"),
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");

    const result = runTool(root, "init", "validate-phase", "2") as {
      ready: boolean;
      failure_reason: string | null;
      summary_count: number;
    };

    expect(result.ready).toBe(false);
    expect(result.failure_reason).toBe("phase 2 is not locally complete enough yet");
    expect(result.summary_count).toBe(1);
  });

  it("init validate-phase fails closed for mismatched summary ids", () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "### Phase 2: Build",
        "",
        "**Goal**: Ship feature",
        "",
        "Plans:",
        "- [ ] 02-01: Implement feature",
        "- [ ] 02-02: Finish feature",
      ].join("\n"),
    );
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-99-SUMMARY.md"), "junk\n");

    const result = runTool(root, "init", "validate-phase", "2") as {
      ready: boolean;
      failure_reason: string | null;
      summary_count: number;
      incomplete_plan_count: number;
      unexpected_summary_ids: string[];
    };

    expect(result.ready).toBe(false);
    expect(result.failure_reason).toBe("phase 2 has malformed or non-roadmap SUMMARY.md artifacts");
    expect(result.summary_count).toBe(2);
    expect(result.incomplete_plan_count).toBe(1);
    expect(result.unexpected_summary_ids).toEqual(["02-99"]);
  });
});
