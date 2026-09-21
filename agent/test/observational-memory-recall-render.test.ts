import { describe, expect, test } from "vitest";
import {
  formatRecallSubject,
  formatRecallSummaryForTui,
  renderRecallCall,
  renderRecallResult,
} from "../src/extensions/observational-memory/tools/recall-render.js";
import type { Text } from "@earendil-works/pi-tui";

const theme = {
  fg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  italic: (t: string) => t,
} as never;

const details = {
  status: "ok",
  memoryId: "628580733aed",
  observationId: "628580733aed",
  collision: false,
  partial: false,
  reflections: [],
  directObservationMatches: [],
  observations: [
    {
      status: "active",
      observationEntryId: "e1",
      observationRecordIndex: 3,
      observation: {
        id: "628580733aed",
        content: "hi",
        timestamp: "2026-09-21T12:59",
        relevance: "high",
      },
      sourceEntries: [
        { id: "s1", origin: "user", timestamp: "2026-09-21 12:59", tokens: 38, qualifiers: [] },
      ],
    },
  ],
  matches: [
    {
      status: "active",
      observationEntryId: "e1",
      observationRecordIndex: 3,
      observation: {
        id: "628580733aed",
        content: "hi",
        timestamp: "2026-09-21T12:59",
        relevance: "high",
      },
      sourceEntries: [
        { id: "s1", origin: "user", timestamp: "2026-09-21 12:59", tokens: 38, qualifiers: [] },
      ],
    },
  ],
  sourceEntries: [
    { id: "s1", origin: "user", timestamp: "2026-09-21 12:59", tokens: 38, qualifiers: [] },
  ],
  unavailableSupportingObservations: [],
  missingSourceEntryIds: [],
  nonSourceEntryIds: [],
} as never;

const result = { content: [{ type: "text", text: "[User @ ...]: ..." }], details } as never;

describe("recall one-liner render", () => {
  test("folds summary into call line for compact mode", () => {
    const context = {
      args: { id: "628580733aed" },
      state: {},
      lastComponent: undefined,
      isPartial: false,
      isError: false,
    } as never;
    renderRecallCall({ id: "628580733aed" }, theme, context);
    const resultComponent = renderRecallResult(result, { expanded: false }, theme, context);
    const call = (context.state as { callComponent: Text }).callComponent.render(400).join("\n");
    expect(call).toContain("recalled");
    expect(call).toContain("628580733aed");
    expect(call).toContain("1 observation");
    expect(call).toContain("1 source");
    expect(call).toContain("~38 tokens");
    expect(resultComponent.render(400).join("\n")).toBe("");
  });

  test("expanded keeps call summary and renders body with footer", () => {
    const context = {
      args: { id: "628580733aed" },
      state: {},
      lastComponent: undefined,
      isPartial: false,
      isError: false,
    } as never;
    renderRecallCall({ id: "628580733aed" }, theme, context);
    const body = renderRecallResult(result, { expanded: true }, theme, context);
    expect(
      (context.state as { callComponent: Text }).callComponent.render(400).join("\n"),
    ).toContain("~38 tokens");
  });

  test("batch subjects collapse and summaries aggregate", () => {
    expect(formatRecallSubject({ ids: ["aa1", "bb2", "cc3", "dd4"] })).toBe("aa1 +3 more");
    const notFound = {
      ...details,
      status: "not_found",
      memoryId: "ffffffffffff",
      reflections: [],
      observations: [],
      matches: [],
      sourceEntries: [],
      directObservationMatches: [],
      unavailableSupportingObservations: [],
    };
    const summary = formatRecallSummaryForTui(
      { ...details, batchResults: [details, notFound] } as never,
      "recalled",
    );
    expect(summary).toContain("1 observation");
    expect(summary).toContain("1 not found");
  });

  test("not found summary", () => {
    expect(
      formatRecallSummaryForTui({ ...details, status: "not_found" } as never, "recalled"),
    ).toBe("not found");
  });
});
