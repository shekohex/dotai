import type { Model, Api } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { registerCompactionReminder } from "../src/extensions/observational-memory/hooks/reminder.js";
import type { Entry } from "../src/extensions/observational-memory/session-ledger/index.js";
import { Runtime } from "../src/extensions/observational-memory/runtime.js";

function remoteModel(): Model<Api> {
  return {
    provider: "codex-openai",
    id: "gpt-5.6-luna",
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as unknown as Model<Api>;
}

function ledgerEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    type: "custom",
    id: "entry-1",
    parentId: "entry-0",
    timestamp: new Date(0).toISOString(),
    customType: "om.observations.recorded",
    data: {
      coversUpToId: "entry-0",
      observations: [
        {
          id: "aaaaaaaaaaaa",
          content: "user likes bananas",
          timestamp: "2026-09-21T15:00:00.000Z",
          relevance: "high",
          tokenCount: 24,
          sourceEntryIds: ["src-1"],
        },
      ],
      droppedObservationIds: [],
    },
    ...overrides,
  } as Entry;
}

function baseEntry(): Entry {
  return {
    type: "message",
    id: "entry-0",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: "i like bananas", timestamp: new Date(0).toISOString() },
  } as unknown as Entry;
}

type Handlers = Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;

type SetupOptions = { passive?: boolean; ledger: Entry[] };

function setup(options: SetupOptions) {
  const handlers: Handlers = new Map();
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (message: unknown, messageOptions: unknown) => {
      sent.push({ message, options: messageOptions });
      return Promise.resolve();
    },
  } as unknown as ExtensionAPI;

  const runtime = new Runtime();
  runtime.ensureConfig("/tmp");
  runtime.config.passive = options.passive ?? false;

  const ctx = {
    cwd: "/tmp",
    hasUI: true,
    model: remoteModel(),
    sessionManager: {
      getBranch: () => options.ledger,
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionContext;

  registerCompactionReminder(pi, runtime);

  const emit = async (event: SessionCompactEvent) => {
    for (const handler of handlers.get("session_compact") ?? []) {
      await handler(event, ctx);
    }
  };

  return { emit, sent, notifications };
}

function compactEvent(): SessionCompactEvent {
  return {
    type: "session_compact",
    compactionEntry: { id: "compaction-1", details: { remoteCompaction: true } },
    fromHook: false,
    reason: "threshold",
    willRetry: false,
  } as unknown as SessionCompactEvent;
}

describe("observational-memory compaction reminder", () => {
  test("notifies after re-injecting memories into context", async () => {
    const { emit, sent, notifications } = setup({ ledger: [baseEntry(), ledgerEntry()] });
    await emit(compactEvent());
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toMatchObject({
      customType: "om.memory.reminder",
      display: false,
    });
    expect(sent[0]?.options).toEqual({ triggerTurn: false, deliverAs: "steer" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe("info");
    expect(notifications[0]?.message).toContain("1 observations");
    expect(notifications[0]?.message).toContain("0 reflections");
  });

  test("no notification when the reminder is skipped", async () => {
    const { emit, sent, notifications } = setup({
      ledger: [baseEntry(), ledgerEntry()],
      passive: true,
    });
    await emit(compactEvent());
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(sent).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });
});
