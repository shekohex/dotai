import { describe, expect, test } from "vitest";
import { buildSummaryMessages } from "../src/extensions/compaction.js";

describe("compaction extension", () => {
  test("adds custom instructions as additional constraints", () => {
    const messages = buildSummaryMessages(
      [],
      "Previous facts",
      "# Goal\nPreserve active goal progress.",
    );

    const text = messages[0]?.content[0]?.text ?? "";
    expect(text).toContain("Previous session summary for context:\nPrevious facts");
    expect(text).toContain("# Additional Constraints And Instructions");
    expect(text).toContain("# Goal\nPreserve active goal progress.");
  });

  test("omits additional constraints when custom instructions are blank", () => {
    const messages = buildSummaryMessages([], undefined, "  ");
    const text = messages[0]?.content[0]?.text ?? "";

    expect(text).not.toContain("# Additional Constraints And Instructions");
  });
});
