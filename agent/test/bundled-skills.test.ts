import { describe, expect, it } from "vitest";

import { discoverSkillPaths } from "../src/extensions/bundled-resources.ts";

describe("bundled skills", () => {
  it("does not include retired plannotator visual explainer skill", () => {
    const skillPath = discoverSkillPaths().find((path) =>
      path.endsWith("/plannotator-visual-explainer/SKILL.md"),
    );

    expect(skillPath).toBeUndefined();
  });
});
