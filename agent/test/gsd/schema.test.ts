import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  PlanningConfigSchema,
  PlanFrontmatterSchema,
  StateFrontmatterSchema,
} from "../../src/extensions/gsd/state/schema.js";

describe("PlanningConfigSchema", () => {
  it("accepts minimal valid config", () => {
    expect(
      Value.Check(PlanningConfigSchema, {
        model_profile: "balanced",
        commit_docs: true,
        parallelization: true,
        search_gitignored: false,
        brave_search: false,
        firecrawl: false,
        exa_search: false,
      }),
    ).toBe(true);
  });

  it("rejects missing required field", () => {
    expect(Value.Check(PlanningConfigSchema, { model_profile: "balanced" })).toBe(false);
  });
});

describe("PlanFrontmatterSchema", () => {
  it("accepts pi-gsd style plan frontmatter", () => {
    expect(
      Value.Check(PlanFrontmatterSchema, {
        phase: "01",
        plan: "01",
        type: "implementation",
        wave: 1,
        depends_on: [],
        files_modified: ["src/index.ts"],
        autonomous: true,
        must_haves: ["feature works", "tests pass"],
      }),
    ).toBe(true);
  });

  it("accepts upstream nested must_haves structure", () => {
    expect(
      Value.Check(PlanFrontmatterSchema, {
        phase: "4.5",
        plan: "01",
        type: "execute",
        wave: 1,
        depends_on: ["04-03"],
        files_modified: ["src/runtime.ts"],
        autonomous: true,
        requirements: ["REQ-401"],
        user_setup: [],
        must_haves: {
          truths: ["CLI reads brownfield state"],
          artifacts: [".planning/STATE.md"],
          key_links: ["parser preserves blank current_plan"],
        },
      }),
    ).toBe(true);
  });
});

describe("StateFrontmatterSchema", () => {
  it("accepts upstream lifecycle yaml shape", () => {
    expect(
      Value.Check(StateFrontmatterSchema, {
        gsd_state_version: "1",
        milestone: "v2.0",
        milestone_name: "Platform",
        current_phase: "4.5",
        current_phase_name: "Stabilization",
        current_plan: "",
        status: "in_progress",
        progress: {
          total_phases: 17,
          completed_phases: 10,
          percent: 59,
        },
      }),
    ).toBe(true);
  });
});
