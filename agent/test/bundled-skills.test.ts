import { describe, expect, it } from "vitest";

import { discoverSkillPaths } from "../src/extensions/bundled-resources.ts";

describe("bundled skills", () => {
  it("includes run-app and debugging skills", () => {
    const skillPaths = discoverSkillPaths();

    expect(skillPaths.some((path) => path.endsWith("/run-app/SKILL.md"))).toBe(true);
    expect(skillPaths.some((path) => path.endsWith("/debugging/SKILL.md"))).toBe(true);
  });

  it("does not include retired plannotator visual explainer skill", () => {
    const skillPath = discoverSkillPaths().find((path) =>
      path.endsWith("/plannotator-visual-explainer/SKILL.md"),
    );

    expect(skillPath).toBeUndefined();
  });
});
