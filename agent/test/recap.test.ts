import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { defaultSettings } from "../src/default-settings.js";
import { groupedExtensionsB } from "../src/extensions/definitions-group-b.js";
import { DEFAULT_MODEL_FALLBACKS } from "../src/extensions/model-fallbacks.js";
import { completeModel } from "../src/extensions/pi-ai-models.js";
import recapExtension from "../src/extensions/recap/index.js";

vi.mock("../src/extensions/pi-ai-models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/extensions/pi-ai-models.js")>();
  return { ...actual, completeModel: vi.fn() };
});

type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

function createHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const widgets = new Map<string, unknown>();
  const notifications: string[] = [];
  const persistedEntries: { customType: string; data: unknown }[] = [];
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
    | undefined;

  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Add recap support" }],
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Implementation is ready." }],
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const contextLeafId = sessionManager.getLeafId();
  sessionManager.appendCustomEntry("recap:state", {
    version: 1,
    recap: "Existing recap",
    contextLeafId,
  });

  const firstModel = {
    provider: DEFAULT_MODEL_FALLBACKS[0].provider,
    id: DEFAULT_MODEL_FALLBACKS[0].model,
    api: "openai-responses",
    baseUrl: "https://example.test/v1",
  };
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    sessionManager,
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        provider === firstModel.provider && modelId === firstModel.id ? firstModel : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      setWidget: (key: string, value: unknown) => {
        widgets.set(key, value);
      },
    },
  } as unknown as ExtensionCommandContext;

  const pi = {
    appendEntry(customType: string, data: unknown) {
      persistedEntries.push({ customType, data });
    },
    on(eventName: string, handler: EventHandler) {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
    registerCommand(
      name: string,
      definition: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> },
    ) {
      if (name === "recap") commandHandler = definition.handler;
    },
  } as unknown as ExtensionAPI;

  recapExtension(pi);

  return {
    notifications,
    persistedEntries,
    widgets,
    async emit(eventName: string, event: unknown = {}) {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler(event as never, ctx);
      }
    },
    async runCommand(args: string) {
      if (commandHandler === undefined) throw new Error("recap command not registered");
      await commandHandler(args, ctx);
    },
  };
}

beforeEach(() => {
  vi.mocked(completeModel).mockReset();
});

describe("recap extension", () => {
  test("is bundled with minimal default settings", () => {
    expect(groupedExtensionsB.some((definition) => definition.id === "recap")).toBe(true);
    expect(defaultSettings.recap).toEqual({ enabled: true, awayDelayMs: 300_000 });
  });

  test("restores current recap and reports status", async () => {
    const harness = createHarness();

    await harness.emit("session_start");
    await harness.runCommand("status");

    expect(harness.widgets.get("recap")).toEqual(["※ recap: Existing recap"]);
    expect(harness.notifications).toContain("recap: enabled; last: current; visible: yes");
    expect(completeModel).not.toHaveBeenCalled();
  });

  test("generates and persists a manual recap using shared fallback models", async () => {
    vi.mocked(completeModel).mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: " Add recap support. Implementation ready.\n" }],
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const harness = createHarness();
    await harness.emit("session_start");

    await harness.runCommand("");

    expect(completeModel).toHaveBeenCalledOnce();
    expect(harness.persistedEntries).toContainEqual({
      customType: "recap:state",
      data: expect.objectContaining({
        version: 1,
        recap: "Add recap support. Implementation ready.",
      }),
    });
    expect(harness.widgets.get("recap")).toEqual([
      "※ recap: Add recap support. Implementation ready.",
    ]);
  });

  test("hides recap and marks it stale on normal input", async () => {
    const harness = createHarness();
    await harness.emit("session_start");

    await harness.emit("input", { source: "interactive", text: "continue" });
    await harness.runCommand("status");

    expect(harness.widgets.get("recap")).toBeUndefined();
    expect(harness.notifications).toContain("recap: enabled; last: stale; visible: no");
  });
});
