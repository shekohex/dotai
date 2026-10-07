import { describe, expect, it } from "vitest";

import { buildConductorSystemPrompt } from "./playbook.js";

describe("buildConductorSystemPrompt", () => {
  const paths = { conductorDir: "/c/1", sharedMemoryDir: "/c/memory" };

  it("appends CONDUCTOR.md after the playbook", () => {
    const prompt = buildConductorSystemPrompt({
      ...paths,
      projectInstructions: {
        path: "/repo/CONDUCTOR.md",
        content: "Use codex for reviews.",
      },
    });
    expect(prompt).toContain("## Project instructions (/repo/CONDUCTOR.md)");
    expect(prompt.trimEnd().endsWith("Use codex for reviews.")).toBe(true);
  });

  it("omits the section when the project has no CONDUCTOR.md", () => {
    expect(
      buildConductorSystemPrompt({ ...paths, projectInstructions: null }),
    ).not.toContain("Project instructions");
  });
});
