import { resolve } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { groupedExtensionsC } from "../src/extensions/definitions-group-c.js";
import { DEFERRED_TOOL_NAMES, SEARCH_TOOL_ALIASES } from "../src/extensions/search-tools.js";
import viewImageExtension, { createViewImageToolDefinition } from "../src/extensions/view-image.js";
import { completeSimpleModel } from "../src/extensions/pi-ai-models.js";

vi.mock("../src/extensions/pi-ai-models.js", () => ({ completeSimpleModel: vi.fn() }));

const visionModel = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} satisfies Model<Api>;

const textModel = {
  ...visionModel,
  id: "text-model",
  provider: "test",
  api: "openai-responses",
  input: ["text"],
} satisfies Model<Api>;

afterEach(() => {
  vi.clearAllMocks();
});

function createImageFixture(): { cwd: string; path: string } {
  const cwd = process.cwd();
  return {
    cwd,
    path: resolve(cwd, "vendor/plannotator-ui/packages/ui/assets/icon-codex.png"),
  };
}

function createContext(cwd: string, model: Model<Api>): ExtensionContext {
  return {
    cwd,
    model,
    modelRegistry: {
      getAvailable: () => [visionModel],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
  } as unknown as ExtensionContext;
}

describe("view_image", () => {
  test("is bundled and discoverable as a deferred tool", () => {
    expect(groupedExtensionsC.some((definition) => definition.id === "view-image")).toBe(true);
    expect(DEFERRED_TOOL_NAMES.has("view_image")).toBe(true);
    expect(SEARCH_TOOL_ALIASES.view_image).toContain("inspect image");
  });

  test("registers without activating itself", () => {
    const registered: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => registered.push(tool.name),
      getActiveTools: () => ["read", "search_tools"],
    } as unknown as ExtensionAPI;

    viewImageExtension(pi);

    expect(registered).toEqual(["view_image"]);
    expect(pi.getActiveTools()).not.toContain("view_image");
  });

  test("returns image content directly to vision-capable models", async () => {
    const fixture = createImageFixture();
    const tool = createViewImageToolDefinition();

    const result = await tool.execute(
      "view-image-1",
      { path: fixture.path },
      undefined,
      undefined,
      createContext(fixture.cwd, visionModel),
    );

    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    );
    expect(completeSimpleModel).not.toHaveBeenCalled();
  });

  test("describes images through a vision helper for text-only models", async () => {
    const fixture = createImageFixture();
    vi.mocked(completeSimpleModel).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "A single white pixel." }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as AssistantMessage);
    const tool = createViewImageToolDefinition();

    const result = await tool.execute(
      "view-image-2",
      { path: fixture.path },
      undefined,
      undefined,
      createContext(fixture.cwd, textModel),
    );

    expect(result.content).toEqual([{ type: "text", text: "A single white pixel." }]);
    expect(completeSimpleModel).toHaveBeenCalledWith(
      visionModel,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ type: "image", mimeType: "image/png" }),
            ]),
          }),
        ],
      }),
      expect.objectContaining({ apiKey: "test-key" }),
    );
  });
});
