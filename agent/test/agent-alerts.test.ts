import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import agentAlertsExtension from "../src/extensions/agent-alerts/index.js";
import { invokeNotifyCallbackHandler } from "../src/extensions/notify/index.js";
import {
  AGENT_ALERT_EVENT,
  AGENT_ALERT_RETRY_EVENT,
} from "../src/extensions/agent-alerts/types.js";

type AlertHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

function createHarness() {
  const handlers = new Map<string, AlertHandler[]>();
  const emittedEvents: Array<{ eventName: string; data: unknown }> = [];
  const pi: ExtensionAPI = {
    appendEntry() {},
    events: {
      emit(eventName, data) {
        emittedEvents.push({ eventName, data });
      },
      on() {
        return () => {};
      },
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    getFlag: () => undefined,
    getSessionName: () => undefined,
    getThinkingLevel: () => "medium",
    on(eventName, handler) {
      const current = handlers.get(eventName) ?? [];
      current.push(handler as AlertHandler);
      handlers.set(eventName, current);
    },
    registerCommand() {},
    registerFlag() {},
    registerMessageRenderer() {},
    registerProvider() {},
    registerShortcut() {},
    registerTool() {},
    sendMessage() {},
    sendUserMessage() {},
    setActiveTools() {},
    setLabel() {},
    setModel: async () => false,
    setSessionName() {},
    setThinkingLevel() {},
    unregisterProvider() {},
  };
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    waitForIdle: async () => {},
    abort() {},
    compact() {},
    fork: async () => ({ cancelled: false }),
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    model: undefined,
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    navigateTree: async () => ({ cancelled: false }),
    newSession: async () => ({ cancelled: false }),
    reload: async () => {},
    sessionManager: {
      getSessionId: () => "session-1",
    } as ExtensionContext["sessionManager"],
    shutdown() {},
    signal: undefined,
    switchSession: async () => ({ cancelled: false }),
    ui: {
      notify() {},
    } as ExtensionContext["ui"],
  } as ExtensionContext;

  agentAlertsExtension(pi);

  async function emit(eventName: string, event: object): Promise<void> {
    for (const handler of handlers.get(eventName) ?? []) {
      await handler(event, ctx);
    }
  }

  return { emittedEvents, emit, pi };
}

describe("agent alerts extension", () => {
  test("emits alert and notify event for retryable provider responses", async () => {
    const harness = createHarness();

    await harness.emit("after_provider_response", {
      type: "after_provider_response",
      status: 429,
      headers: {},
    });

    expect(
      harness.emittedEvents.find((event) => event.eventName === AGENT_ALERT_EVENT)?.data,
    ).toMatchObject({
      kind: "provider_retryable_response",
      statusCode: 429,
      sessionId: "session-1",
    });
    expect(
      harness.emittedEvents.find((event) => event.eventName === "notify:publish")?.data,
    ).toMatchObject({
      title: "Agent alert",
      actions: [{ action: "callback", label: "Retry", key: expect.any(String) }],
    });
  });

  test("retry action emits retry event", async () => {
    const harness = createHarness();

    await harness.emit("after_provider_response", {
      type: "after_provider_response",
      status: 503,
      headers: {},
    });

    const publishEvent = harness.emittedEvents.find(
      (event) => event.eventName === "notify:publish",
    )?.data;
    if (
      typeof publishEvent !== "object" ||
      publishEvent === null ||
      !("actions" in publishEvent) ||
      !Array.isArray(publishEvent.actions)
    ) {
      throw new Error("publish event missing actions");
    }
    const firstAction = publishEvent.actions[0];
    if (
      typeof firstAction !== "object" ||
      firstAction === null ||
      !("key" in firstAction) ||
      typeof firstAction.key !== "string"
    ) {
      throw new Error("retry key missing");
    }
    const retryEvent = harness.emittedEvents.find(
      (event) => event.eventName === AGENT_ALERT_EVENT,
    )?.data;
    if (
      typeof retryEvent !== "object" ||
      retryEvent === null ||
      !("alertId" in retryEvent) ||
      typeof retryEvent.alertId !== "string" ||
      !("kind" in retryEvent) ||
      typeof retryEvent.kind !== "string"
    ) {
      throw new Error("alert event missing payload");
    }

    await invokeNotifyCallbackHandler(harness.pi, firstAction.key, {
      correlationId: retryEvent.alertId,
      actionId: "action-1",
      sourceExtension: "agent-alerts",
      callbackChannel: firstAction.key,
      callbackPayload: {
        alertId: retryEvent.alertId,
        kind: retryEvent.kind,
        sessionId: "session-1",
      },
      request: {
        method: "POST",
        path: "/notify/action",
        query: {},
        headers: {},
        body: "",
        timestamp: Date.now(),
      },
    });

    expect(
      harness.emittedEvents.find((event) => event.eventName === AGENT_ALERT_RETRY_EVENT)?.data,
    ).toMatchObject({
      alertId: retryEvent.alertId,
      kind: retryEvent.kind,
      sessionId: "session-1",
    });
  });
});
