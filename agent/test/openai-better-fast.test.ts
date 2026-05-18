import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _test } from "../src/extensions/openai-better/index.js";
import { setOpenAIBetterFastEnabled } from "../src/extensions/openai-better/settings.js";

describe("openai better fast mode", () => {
  it("supports codex-openai and openai-codex default fast models", () => {
    expect(_test.DEFAULT_SUPPORTED_MODELS).toEqual([
      "codex-openai/gpt-5.4",
      "codex-openai/gpt-5.5",
      "codex-openai/gpt-5.4-mini",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.4-mini",
    ]);
  });

  it("allows openai-codex fast model matching", () => {
    expect(
      _test.supportsFast(
        { model: { provider: "openai-codex", id: "gpt-5.5" } } as never,
        _test.DEFAULT_SUPPORTED_MODELS,
      ),
    ).toBe(true);
  });

  it("normalizes legacy fast service tier to priority", () => {
    expect(_test.normalizeFastServiceTier("fast")).toBe("priority");
    expect(_test.applyFastServiceTier({ model: "gpt-5.5", service_tier: "fast" })).toEqual({
      model: "gpt-5.5",
      service_tier: "priority",
    });
  });

  it("sets priority service tier without changing existing priority payload identity", () => {
    const payload = { model: "gpt-5.5", service_tier: "priority" };

    expect(_test.applyFastServiceTier(payload)).toBe(payload);
    expect(_test.applyFastServiceTier({ model: "gpt-5.5" })).toEqual({
      model: "gpt-5.5",
      service_tier: "priority",
    });
  });

  it("persists fast enabled while preserving existing settings", () => {
    const previousRuntime = process.env.PI_CODING_AGENT_DIR;
    const runtime = mkdtempSync(join(tmpdir(), "agent-openai-better-fast-"));
    process.env.PI_CODING_AGENT_DIR = runtime;

    try {
      writeFileSync(
        join(runtime, "settings.json"),
        JSON.stringify({ theme: "catppuccin-mocha", openaiBetter: _test.DEFAULT_CONFIG }),
      );

      setOpenAIBetterFastEnabled(true);

      expect(JSON.parse(readFileSync(join(runtime, "settings.json"), "utf-8"))).toMatchObject({
        theme: "catppuccin-mocha",
        openaiBetter: { fast: { enabled: true } },
      });
    } finally {
      if (previousRuntime === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousRuntime;
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});
