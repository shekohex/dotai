import { describe, expect, it } from "vitest";

import { formatConductorNotice } from "./notice.js";

/** Mirrors Paseo's SYSTEM_ENVELOPE_PATTERN in packages/server/src/server/agent/agent-prompt.ts. */
const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

describe("formatConductorNotice", () => {
  it("matches Paseo's hidden system envelope", () => {
    const text = formatConductorNotice({
      agentId: "w1",
      title: "Docs",
      reason: "is stalled",
      detail: "No activity for 12 minutes.",
    });
    expect(text).toMatch(SYSTEM_ENVELOPE_PATTERN);
    expect(text).toContain("Agent w1 (Docs) is stalled.");
  });
});
