import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

const require = createRequire(import.meta.url);
const testDir = fileURLToPath(new URL(".", import.meta.url));
const drift = require("../../src/resources/gsd/bin/lib/drift.cjs") as {
  detectDrift: (input: {
    addedFiles: string[];
    modifiedFiles: string[];
    deletedFiles: string[];
    structureMd: string;
    threshold?: number;
    action?: "warn" | "auto-remap";
  }) => {
    skipped: boolean;
    affectedPaths: string[];
    message: string;
  };
};

function createRoot(): string {
  return createTempDirSync("agent-gsd-drift-");
}

function initRepo(root: string): void {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
    stdio: "ignore",
  });
}

function runVerifyCodebaseDrift(root: string): {
  skipped: boolean;
  reason: string | null;
  directive?: string;
  spawn_mapper?: boolean;
  message?: string;
} {
  const script = [
    "const verify = require('./src/resources/gsd/bin/lib/verify.cjs');",
    `verify.cmdVerifyCodebaseDrift(${JSON.stringify(root)}, true);`,
  ].join(" ");
  const stdout = execFileSync("node", ["-e", script], {
    cwd: join(testDir, "..", ".."),
    encoding: "utf8",
  });
  return JSON.parse(stdout) as {
    skipped: boolean;
    reason: string | null;
    directive?: string;
    spawn_mapper?: boolean;
    message?: string;
  };
}

function writeCanonicalCodebaseMap(
  root: string,
  mappedCommit: string | null,
  overrides?: Record<string, string>,
): void {
  mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
  for (const name of [
    "STACK.md",
    "INTEGRATIONS.md",
    "ARCHITECTURE.md",
    "STRUCTURE.md",
    "CONVENTIONS.md",
    "TESTING.md",
    "CONCERNS.md",
  ]) {
    const frontmatter =
      overrides?.[name] ??
      (mappedCommit === null
        ? ""
        : `---\nlast_mapped_commit: ${mappedCommit}\nlast_mapped_at: 2026-05-06T00:00:00.000Z\n---\n`);
    writeFileSync(
      join(root, ".planning", "codebase", name),
      `${frontmatter}# ${name}\n\nDetailed analysis for ${name}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
    );
  }
}

describe("gsd drift integration", () => {
  it("sanitizes scoped package drift hints without dropping @scope paths", () => {
    const result = drift.detectDrift({
      addedFiles: ["packages/@scope/ui/src/index.ts"],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: "# Structure\n\n`src/legacy`\n",
      threshold: 1,
      action: "warn",
    });

    expect(result.skipped).toBe(false);
    expect(result.affectedPaths).toEqual(["packages/@scope/ui"]);
    expect(result.message).toContain("/gsd map-codebase update");
  });

  it("suppresses auto-remap when sanitized affected paths collapse to empty", () => {
    const result = drift.detectDrift({
      addedFiles: ["src bad/file.ts"],
      modifiedFiles: [],
      deletedFiles: [],
      structureMd: "# Structure\n\n`src/legacy`\n",
      threshold: 1,
      action: "auto-remap",
    });

    expect(result.skipped).toBe(false);
    expect(result.affectedPaths).toEqual([]);
    expect(result.directive).toBe("warn");
    expect(result.spawnMapper).toBe(false);
    expect(result.message).toContain("could not be reduced to safe");
  });

  it("normalizes local drift verify output to non-runnable warning state", () => {
    const root = createRoot();
    initRepo(root);
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    mkdirSync(join(root, ".planning"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      JSON.stringify({ workflow: { drift_action: "auto-remap", drift_threshold: 1 } }),
    );
    writeCanonicalCodebaseMap(root, commitSha);
    mkdirSync(join(root, "packages", "newpkg", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "newpkg", "src", "index.ts"), "export {}\n");
    mkdirSync(join(root, "packages", "otherpkg", "src"), { recursive: true });
    writeFileSync(join(root, "packages", "otherpkg", "src", "index.ts"), "export {}\n");
    mkdirSync(join(root, "migrations"), { recursive: true });
    writeFileSync(join(root, "migrations", "001_init.sql"), "select 1;\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "drift"], { cwd: root, stdio: "ignore" });

    const output = runVerifyCodebaseDrift(root);
    expect(output.skipped).toBe(false);
    expect(output.directive).toBe("warn");
    expect(output.spawn_mapper).toBe(false);
    expect(output.message).toContain("/gsd map-codebase update");
  });

  it("skips codebase drift when last_mapped_commit is missing", () => {
    const root = createRoot();
    initRepo(root);
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    writeCanonicalCodebaseMap(root, null);

    const output = runVerifyCodebaseDrift(root);
    expect(output.skipped).toBe(true);
    expect(output.reason).toBe("missing-last-mapped-commit");
  });

  it("skips codebase drift when last_mapped_commit is invalid", () => {
    const root = createRoot();
    initRepo(root);
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    writeCanonicalCodebaseMap(root, "deadbeef");

    const output = runVerifyCodebaseDrift(root);
    expect(output.skipped).toBe(true);
    expect(output.reason).toBe("invalid-last-mapped-commit");
  });

  it("skips codebase drift when last_mapped_commit is not ancestor of HEAD", () => {
    const root = createRoot();
    initRepo(root);
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const baseBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", ["checkout", "-b", "side"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "SIDE.md"), "side\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "side"], { cwd: root, stdio: "ignore" });
    const sideCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", ["checkout", baseBranch], { cwd: root, stdio: "ignore" });
    writeCanonicalCodebaseMap(root, sideCommit);

    const output = runVerifyCodebaseDrift(root);
    expect(output.skipped).toBe(true);
    expect(output.reason).toBe("non-ancestor-last-mapped-commit");
  });

  it("skips codebase drift when canonical map is partial", () => {
    const root = createRoot();
    initRepo(root);
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "codebase", "STRUCTURE.md"),
      "---\nlast_mapped_commit: deadbeef\n---\n# Structure\n\nBody\n",
    );
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });

    const output = runVerifyCodebaseDrift(root);
    expect(output.skipped).toBe(true);
    expect(output.reason).toBe("incomplete-codebase-map");
  });

  it("skips codebase drift when canonical map has mixed baseline commits", () => {
    const root = createRoot();
    initRepo(root);
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    for (const name of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      const baseline = name === "STRUCTURE.md" ? commitSha : "deadbeef";
      writeFileSync(
        join(root, ".planning", "codebase", name),
        `---\nlast_mapped_commit: ${baseline}\n---\n# ${name}\n\nDetailed analysis for ${name}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }

    const output = runVerifyCodebaseDrift(root);
    expect(output.skipped).toBe(true);
    expect(output.reason).toBe("mixed-last-mapped-commit");
  });

  it("skips codebase drift when canonical map body is frontmatter only", () => {
    const root = createRoot();
    initRepo(root);
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    writeCanonicalCodebaseMap(root, commitSha);
    writeFileSync(
      join(root, ".planning", "codebase", "STRUCTURE.md"),
      `---\nlast_mapped_commit: ${commitSha}\nlast_mapped_at: 2026-05-06T00:00:00.000Z\n---\n`,
    );

    const output = runVerifyCodebaseDrift(root);
    expect(output.skipped).toBe(true);
    expect(output.reason).toBe("invalid-codebase-map-body");
  });

  it("skips codebase drift when canonical map body is only a stub heading", () => {
    const root = createRoot();
    initRepo(root);
    writeFileSync(join(root, "README.md"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    writeCanonicalCodebaseMap(root, commitSha);
    writeFileSync(
      join(root, ".planning", "codebase", "STRUCTURE.md"),
      `---\nlast_mapped_commit: ${commitSha}\nlast_mapped_at: 2026-05-06T00:00:00.000Z\n---\n# Structure\n`,
    );

    const output = runVerifyCodebaseDrift(root);
    expect(output.skipped).toBe(true);
    expect(output.reason).toBe("invalid-codebase-map-body");
  });
});
