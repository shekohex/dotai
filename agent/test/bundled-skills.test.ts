import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { discoverSkillPaths } from "../src/extensions/bundled-resources.ts";

describe("bundled skills", () => {
  it("includes run-app skill", () => {
    const skillPaths = discoverSkillPaths();

    expect(skillPaths.some((path) => path.endsWith("/run-app/SKILL.md"))).toBe(true);
  });

  it("includes setup-pi-conductor skill", () => {
    const skillPaths = discoverSkillPaths();

    expect(skillPaths.some((path) => path.endsWith("/setup-pi-conductor/SKILL.md"))).toBe(true);
  });

  it("includes run skill generator and examples", () => {
    const skillPaths = discoverSkillPaths();
    const generatorPath = skillPaths.find((path) => path.endsWith("/run-skill-generator/SKILL.md"));
    const runAppPath = skillPaths.find((path) => path.endsWith("/run-app/SKILL.md"));

    expect(generatorPath).toBeDefined();
    expect(runAppPath).toBeDefined();
    expect(existsSync(join(dirname(generatorPath!), "template.md"))).toBe(true);

    const runAppDir = dirname(runAppPath!);
    for (const example of ["cli", "server", "tui", "electron", "playwright", "library"]) {
      expect(existsSync(join(runAppDir, "examples", `${example}.md`))).toBe(true);
    }
  });

  it("does not include retired plannotator visual explainer skill", () => {
    const skillPath = discoverSkillPaths().find((path) =>
      path.endsWith("/plannotator-visual-explainer/SKILL.md"),
    );

    expect(skillPath).toBeUndefined();
  });
});
