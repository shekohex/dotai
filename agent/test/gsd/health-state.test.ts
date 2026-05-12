import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeLocalHealthSummary } from "../../src/extensions/gsd/state/health.js";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

function createRootWithMalformedConfig(): string {
  const root = createTempDirSync("agent-gsd-health-state-");
  mkdirSync(join(root, ".planning", "phases", "01-setup"), { recursive: true });
  writeFileSync(join(root, ".planning", "config.json"), "{broken\n");
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: 01-01\nstatus: Ready to execute\n",
  );
  writeFileSync(
    join(root, ".planning", "ROADMAP.md"),
    "# Roadmap: Demo\n\n### Phase 1: Setup\n**Goal**: Build base\n\nPlans:\n- [ ] 01-01: Create base\n",
  );
  writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
  writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(
    join(root, ".planning", "phases", "01-setup", "01-01-PLAN.md"),
    "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/index.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
  );
  return root;
}

describe("gsd health local summary", () => {
  it("treats malformed config as broken in hot paths", () => {
    const result = computeLocalHealthSummary(createRootWithMalformedConfig());
    expect(result.status).toBe("broken");
    expect(result.healthy).toBe(false);
    expect(result.issues).toContainEqual({
      severity: "error",
      code: "ELOCAL_CONFIG",
      message: "config.json malformed",
    });
  });

  it("ignores stale non-roadmap phase dirs in hot-path summary", () => {
    const root = createTempDirSync("agent-gsd-health-state-stale-phase-");
    mkdirSync(join(root, ".planning", "phases", "01-setup"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "stale-phase"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: 01-01\nstatus: Ready to execute\n",
    );
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      "# Roadmap: Demo\n\n### Phase 1: Setup\n**Goal**: Build base\n\nPlans:\n- [ ] 01-01: Create base\n",
    );
    writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
    writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
    writeFileSync(
      join(root, ".planning", "phases", "01-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/index.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
    );

    const result = computeLocalHealthSummary(root);
    expect(result.status).toBe("degraded");
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({
        code: "WLOCAL_PHASE_NAME",
        message: 'Phase directory "stale-phase" doesn\'t follow NN-name format',
      }),
    );
  });
});
