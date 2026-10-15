import { describe, expect, it } from "vitest";

import { progressGuide } from "./progress-guide.js";
import { buildConductorSystemPrompt } from "./playbook.js";

// Agents pay for these in tokens on every call or turn; raise a budget only on purpose.
const GUIDE_BUDGET = 4_000;
const PLAYBOOK_BUDGET = 7_000;

describe("progress guide", () => {
  const guide = progressGuide("/t", "AI");

  it("stays within its size budget", () => {
    expect(guide.length).toBeLessThanOrEqual(GUIDE_BUDGET);
  });

  it("covers updates, labels, estimates, and ids with the prefix", () => {
    for (const topic of [
      "## 3. Links and mentions",
      "## 4. Good updates",
      "## 5. Labels",
      "## 6. Estimates, percent, ETA",
      "parent=AI-01",
      "#AI-03",
      "AI-01",
      "id=AI-03",
      "check-in",
    ])
      expect(guide).toContain(topic);
    expect(guide).not.toContain("T03");
  });
});

describe("conductor playbook", () => {
  it("stays within its size budget", () => {
    const prompt = buildConductorSystemPrompt({
      conductorDir: "/c/1",
      sharedMemoryDir: "/c/memory",
      projectInstructions: null,
    });
    expect(prompt.length).toBeLessThanOrEqual(PLAYBOOK_BUDGET);
  });
});
