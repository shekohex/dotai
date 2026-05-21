import { describe, expect, test } from "vitest";
import { buildTPSStatus, composeFooterLine } from "../src/extensions/coreui/footer.js";
import type { CoreUIState } from "../src/extensions/coreui/types.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
} as never;

const stateWithTps = (tpsVisible: boolean): CoreUIState => ({
  repoSlug: undefined,
  worktreeName: undefined,
  dirty: false,
  addedLines: 0,
  removedLines: 0,
  aheadCommits: 0,
  behindCommits: 0,
  totalCost: 0,
  activeMode: undefined,
  activeModeColor: undefined,
  tpsVisible,
  tpsElapsedMs: 65_000,
  tps: {
    current: 12.3,
    min: 10,
    median: 11,
    max: 14,
    sampleCount: 2,
    bufferSize: 50,
  },
});

describe("coreui footer", () => {
  test("hides only tps when tps visibility is disabled", () => {
    expect(buildTPSStatus(theme, stateWithTps(false), 120)).toBe("");
    expect(composeFooterLine("Pursuing goal", "ctx 10K", 40)).toContain("Pursuing goal");
  });

  test("auto hides tps on narrow terminals", () => {
    expect(buildTPSStatus(theme, stateWithTps(true), 95)).toBe("");
    expect(buildTPSStatus(theme, stateWithTps(true), 96)).toContain("tps 12.3");
  });
});
