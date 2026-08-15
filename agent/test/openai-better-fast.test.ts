import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple as streamOpenAICodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { _test } from "../src/extensions/openai-better/index.js";
import { setOpenAIBetterFastEnabled } from "../src/extensions/openai-better/settings.js";

describe("openai better fast mode", () => {
  it("supports codex-openai and openai-codex default fast models", () => {
    expect(_test.DEFAULT_SUPPORTED_MODELS).toEqual([
      "codex-openai/gpt-5.6-sol",
      "codex-openai/gpt-5.6-terra",
      "codex-openai/gpt-5.6-luna",
      "codex-openai/gpt-5.4",
      "codex-openai/gpt-5.5",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-terra",
      "openai-codex/gpt-5.6-luna",
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

  it("uses Codex CLI request identity only in fast mode", () => {
    expect(_test.applyCodexOpenAIHeaders({ Originator: "pi" }, "gpt-5.6-sol", false)).toEqual({
      originator: "pi",
    });
    expect(
      _test.applyCodexOpenAIHeaders(
        { originator: "pi", "X-Codex-Routing-Hint": "stale" },
        "gpt-5.6-luna",
        true,
      ),
    ).toEqual({
      originator: "codex_cli_rs",
      "x-codex-routing-hint": "model=gpt-5.6-luna;tier=priority",
    });
  });

  it("preserves fast routing identity through the stock Codex provider", async () => {
    const model = getBuiltinModels("openai-codex").find(
      (candidate) => candidate.id === "gpt-5.6-sol",
    );
    if (model === undefined) throw new Error("Missing gpt-5.6-sol model");
    let requestHeaders: Headers | undefined;
    const server = createServer((request, response) => {
      requestHeaders = new Headers(
        Object.entries(request.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
        ),
      );
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_fast",
            status: "completed",
            model: model.id,
            service_tier: "default",
            output: [],
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        })}\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    const tokenPayload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }),
    ).toString("base64url");
    const headers = _test.applyCodexOpenAIHeaders({}, model.id, true);

    try {
      const message = await streamOpenAICodex(
        { ...model, baseUrl: `http://127.0.0.1:${address.port}` },
        { messages: [{ role: "user", content: "hello" }] },
        {
          apiKey: `header.${tokenPayload}.signature`,
          headers,
          onPayload: (payload) =>
            _test.applyFastServiceTier(payload as Record<string, unknown>) as never,
          transport: "sse",
        },
      ).result();

      expect(requestHeaders?.get("originator")).toBe("codex_cli_rs");
      expect(requestHeaders?.get("x-codex-routing-hint")).toBe("model=gpt-5.6-sol;tier=priority");
      expect(message.usage.cost.total).toBeCloseTo((model.cost.input / 1_000_000) * 2, 10);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
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
