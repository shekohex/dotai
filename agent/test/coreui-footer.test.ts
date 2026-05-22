import { describe, expect, test } from "vitest";
import {
  buildSessionElapsedStatus,
  buildTPSStatus,
  composeFooterLine,
} from "../src/extensions/coreui/footer.js";
import type { CoreUIState } from "../src/extensions/coreui/types.js";

const theme = {
  fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
  bold: (value: string) => `<b>${value}</b>`,
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
    expect(buildTPSStatus(theme, stateWithTps(false))).toBe("");
    expect(buildSessionElapsedStatus(theme, stateWithTps(false))).toBe("<dim>1m 5s</dim>");
    expect(composeFooterLine("Pursuing goal", "ctx 10K", 40)).toContain("Pursuing goal");
  });

  test("preserves bottom-left status on narrow terminals with long right status", () => {
    const line = composeFooterLine(
      "Pursuing goal",
      "ctx 999.9M (100%) · $9999.99 · other long status",
      24,
      { priority: "left" },
    );

    expect(line).toContain("Pursuing goal");
  });

  test("truncates bottom-left status instead of dropping it when extremely narrow", () => {
    const line = composeFooterLine("Pursuing very long goal", "ctx 999.9M", 12, {
      priority: "left",
    });

    expect(line).toContain("Pursuing");
    expect(line).not.toContain("ctx");
  });

  test("shows compact current tps only", () => {
    expect(buildTPSStatus(theme, stateWithTps(true))).toBe(
      "<warning>󰓅</warning><dim> </dim><accent>12.3</accent>",
    );
  });

  test("renders hot tps icon red and bold near max", () => {
    const state = stateWithTps(true);
    state.tps = { ...state.tps!, current: 13.5 };
    expect(buildTPSStatus(theme, state)).toContain("<b><error>󰓅</error></b>");
  });
});
