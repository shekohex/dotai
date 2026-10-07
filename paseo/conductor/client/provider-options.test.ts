import { describe, expect, it } from "vitest";

import {
  modelOptions,
  resolveSelection,
  selectableProviders,
  thinkingOptions,
  type SnapshotEntry,
} from "./provider-options.js";

const entries: SnapshotEntry[] = [
  {
    provider: "claude",
    label: "Claude",
    enabled: true,
    status: "ready",
    models: [
      {
        id: "haiku",
        label: "Haiku",
        thinkingOptions: [{ id: "low", label: "Low" }],
      },
      {
        id: "opus",
        label: "Opus",
        isDefault: true,
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        defaultThinkingOptionId: "medium",
      },
      { id: "hidden", label: "Hidden", isSelectable: false },
    ],
  },
  { provider: "copilot", enabled: false, status: "unavailable" },
  { provider: "omp", enabled: true, status: "error" },
  {
    provider: "codex",
    label: "Codex",
    enabled: true,
    status: "ready",
    models: [],
  },
];

describe("provider options", () => {
  const providers = selectableProviders(entries);

  it("lists only enabled, ready providers and selectable models", () => {
    expect(providers.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
    ]);
    expect(modelOptions(providers[0]).map((option) => option.value)).toEqual([
      "haiku",
      "opus",
    ]);
    expect(modelOptions(providers[1])).toEqual([
      { label: "Provider default", value: "" },
    ]);
  });

  it("keeps valid saved choices", () => {
    expect(
      resolveSelection(providers, {
        provider: "claude",
        model: "opus",
        thinkingOptionId: "high",
      }),
    ).toEqual({ provider: "claude", model: "opus", thinkingOptionId: "high" });
  });

  it("falls back to defaults when saved choices are gone", () => {
    expect(
      resolveSelection(providers, {
        provider: "copilot",
        model: "x",
        thinkingOptionId: "max",
      }),
    ).toEqual({
      provider: "claude",
      model: "opus",
      thinkingOptionId: "medium",
    });
    expect(
      resolveSelection(providers, {
        provider: "claude",
        model: "haiku",
        thinkingOptionId: "max",
      }),
    ).toEqual({ provider: "claude", model: "haiku", thinkingOptionId: "low" });
    expect(
      resolveSelection([], { provider: "", model: "", thinkingOptionId: "" }),
    ).toBeNull();
  });

  it("lists thinking levels of the selected model", () => {
    expect(
      thinkingOptions(providers[0], "opus").map((option) => option.value),
    ).toEqual(["medium", "high"]);
    expect(thinkingOptions(providers[1], "")).toEqual([]);
  });
});
