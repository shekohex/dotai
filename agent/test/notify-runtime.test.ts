import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createNotifyCallbackAction,
  default as notifyExtension,
  invokeNotifyCallbackHandler,
  publishNotify,
  takePendingCallback,
  type PendingCallback,
} from "../src/extensions/notify/index.js";
import { createNotifyTool, waitForBlockingResponse } from "../src/extensions/notify/tool.js";

class EventBus {
  private readonly handlers = new Map<string, Array<(data: unknown) => void>>();

  on(eventName: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
    return () => {
      const nextHandlers = (this.handlers.get(eventName) ?? []).filter((item) => item !== handler);
      this.handlers.set(eventName, nextHandlers);
    };
  }

  emit(eventName: string, data: unknown): void {
    for (const handler of this.handlers.get(eventName) ?? []) {
      handler(data);
    }
  }
}

function createFakePi(): ExtensionAPI {
  const events = new EventBus();
  return {
    events,
  } as unknown as ExtensionAPI;
}

describe("notify callback runtime", () => {
  test("notify extension does not register agent tool", () => {
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];
    const pi = {
      events: new EventBus(),
      on() {},
      registerCommand(name: string) {
        registeredCommands.push(name);
      },
      registerTool(tool: { name: string }) {
        registeredTools.push(tool.name);
      },
    } as unknown as ExtensionAPI;

    notifyExtension(pi);

    expect(registeredCommands).toContain("notify");
    expect(registeredTools).not.toContain("notify");
  });

  test("waitForBlockingResponse ignores other correlation ids", async () => {
    const pi = createFakePi();
    const responsePromise = waitForBlockingResponse(pi, "wanted", undefined);

    pi.events.emit("notify:action_response", { correlationId: "other", statusCode: 204 });

    let resolved = false;
    void responsePromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    pi.events.emit("notify:action_response", { correlationId: "wanted", statusCode: 200 });

    await expect(responsePromise).resolves.toMatchObject({
      correlationId: "wanted",
      statusCode: 200,
    });
  });

  test("takePendingCallback invalidates callback after first use", () => {
    const pending: PendingCallback = {
      actionId: "action-1",
      sourceExtension: "test",
      callbackChannel: "test:callback",
      callbackPayload: { ok: true },
      awaitResponse: false,
      timeoutMs: 1_000,
    };
    const callbackEntries = new Map<string, PendingCallback>([["corr-1", pending]]);

    expect(takePendingCallback(callbackEntries, "corr-1")).toEqual(pending);
    expect(takePendingCallback(callbackEntries, "corr-1")).toBeUndefined();
    expect(callbackEntries.size).toBe(0);
  });

  test("invokeNotifyCallbackHandler reports handler failures cleanly", async () => {
    const pi = createFakePi();
    let emittedPayload: unknown;
    const emit = pi.events.emit.bind(pi.events);
    pi.events.emit = (eventName: string, data: unknown) => {
      if (eventName === "notify:publish") {
        emittedPayload = data;
      }
      emit(eventName, data);
    };

    publishNotify(
      pi,
      {
        topic: "pi",
        message: "hello",
        actions: [createNotifyCallbackAction({ key: "retry-job", label: "Retry" })],
        meta: { sourceExtension: "test", correlationId: "corr-1" },
      },
      {
        onAction: async () => {
          throw new Error("boom");
        },
      },
    );

    const callbackChannel = (emittedPayload as { actions?: Array<{ key?: string }> }).actions?.[0]
      ?.key;
    expect(callbackChannel).toBeTruthy();

    await expect(
      invokeNotifyCallbackHandler(pi, callbackChannel ?? "", {
        correlationId: "corr-1",
        actionId: "action-1",
        sourceExtension: "test",
        callbackChannel: callbackChannel ?? "",
        request: {
          method: "POST",
          path: "/notify/action",
          query: {},
          headers: {},
          body: "",
          timestamp: Date.now(),
        },
      }),
    ).resolves.toEqual({ ok: false, error: "boom" });
  });

  test("notify tool marks blocking callback actions as awaitResponse", async () => {
    const pi = createFakePi();
    let publishedPayload:
      | {
          meta?: { correlationId?: string };
          actions?: Array<{ awaitResponse?: boolean }>;
        }
      | undefined;
    const emit = pi.events.emit.bind(pi.events);
    pi.events.emit = (eventName: string, data: unknown) => {
      emit(eventName, data);
      if (eventName === "notify:publish") {
        publishedPayload = data as {
          meta?: { correlationId?: string };
          actions?: Array<{ awaitResponse?: boolean }>;
        };
        queueMicrotask(() => {
          emit("notify:action_response", {
            correlationId: publishedPayload?.meta?.correlationId,
            statusCode: 200,
            body: "done",
          });
        });
      }
    };

    const tool = createNotifyTool(pi);
    const result = await tool.execute(
      "tool-call",
      {
        message: "Approve?",
        actions: [createNotifyCallbackAction({ key: "approve", label: "Approve" })],
        blocking: true,
      },
      undefined,
      () => {},
      {
        cwd: process.cwd(),
        hasUI: false,
        ui: { notify: () => {} },
        modelRegistry: {
          authStorage: {
            getApiKey: async () => undefined,
          },
        },
      } as never,
    );

    expect(publishedPayload?.actions?.[0]?.awaitResponse).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.details).toMatchObject({
      queued: true,
      blockingResponse: { body: "done", statusCode: 200 },
    });
  });
});
