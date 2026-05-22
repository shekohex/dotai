import { Text } from "@earendil-works/pi-tui";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  getContextPruneAPI,
  setContextPruneRuntime,
  type FlushResult,
} from "../src/extensions/context-prune/public-api.js";
import {
  renderContextPruneCall,
  renderContextPruneResult,
  renderContextTreeQueryCall,
  renderContextTreeQueryResult,
} from "../src/extensions/context-prune/tool-render.js";
import { DEFAULT_CONFIG } from "../src/extensions/context-prune/types.js";

const theme = {
  fg: (_token: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
};

const renderContext = {
  isPartial: false,
  isError: false,
  lastComponent: undefined,
};

function renderText(component: Text): string {
  return component.render(120).join("\n");
}

describe("context-prune public API", () => {
  test("flush proxy and prune callbacks work", async () => {
    const callbacks = new Set<(result: FlushResult) => void>();
    const result: FlushResult = {
      ok: true,
      reason: "flushed",
      batchCount: 1,
      toolCallCount: 2,
      rawCharCount: 100,
      summaryCharCount: 20,
    };
    setContextPruneRuntime({
      getConfig: () => ({ ...DEFAULT_CONFIG, enabled: true }),
      async flush() {
        for (const callback of callbacks) callback(result);
        return result;
      },
      pendingBatchCount: () => 1,
      onPrune(callback) {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
        };
      },
    });
    const api = getContextPruneAPI({} as never);
    expect(api?.enabled).toBe(true);
    const seen: FlushResult[] = [];
    const unsubscribe = api?.onPrune((value) => seen.push(value));
    await expect(api?.flush({ delivery: "session" })).resolves.toEqual(result);
    expect(seen).toEqual([result]);
    unsubscribe?.();
  });
});

describe("context-prune settings", () => {
  test("saves under contextPrune in main agent settings", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "context-prune-settings-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    vi.resetModules();
    const { saveConfig, loadConfig, SETTINGS_PATH } =
      await import("../src/extensions/context-prune/config.js");
    writeFileSync(SETTINGS_PATH, `${JSON.stringify({ modes: { current: "build" } })}\n`, "utf-8");
    await saveConfig({ ...DEFAULT_CONFIG, enabled: true, pruneOn: "on-demand" });
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
    expect(settings.modes).toEqual({ current: "build" });
    expect(settings.contextPrune).toMatchObject({ enabled: true, pruneOn: "on-demand" });
    await expect(loadConfig()).resolves.toMatchObject({ enabled: true, pruneOn: "on-demand" });
    delete process.env.PI_CODING_AGENT_DIR;
  });
});

describe("context-prune tool rendering", () => {
  test("context_prune renderers use compact rail status", () => {
    const call = renderContextPruneCall({}, theme, { ...renderContext, isPartial: true });
    const result = renderContextPruneResult(
      { details: { ok: true, reason: "flushed", toolCallCount: 3, batchCount: 1 } },
      {},
      theme,
      renderContext,
    );
    expect(call).toBeInstanceOf(Text);
    expect(result).toBeInstanceOf(Text);
    expect(renderText(call)).toContain("Pruning");
    expect(renderText(result)).toContain("Pruned");
  });

  test("context_tree_query renderers summarize refs and hits", () => {
    const call = renderContextTreeQueryCall({ toolCallIds: ["T1", "T2"] }, theme, renderContext);
    const result = renderContextTreeQueryResult(
      { details: { results: { T1: {}, T2: {} } } },
      {},
      theme,
      renderContext,
    );
    expect(renderText(call)).toContain("2 refs");
    expect(renderText(result)).toContain("2 found");
  });
});
