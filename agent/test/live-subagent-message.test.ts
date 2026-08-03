import { EventEmitter } from "node:events";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const liveControlMessages = vi.hoisted(() => [] as unknown[]);
const liveControlSessionIds = vi.hoisted(() => [] as string[]);

vi.mock("../src/extensions/live/transport.js", () => ({
  CodexLiveControl: class {
    constructor(options: { sessionId: string }) {
      liveControlSessionIds.push(options.sessionId);
    }

    connect(): Promise<string> {
      return Promise.resolve("answer-sdp");
    }

    send(message: unknown): Promise<void> {
      liveControlMessages.push(message);
      return Promise.resolve();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { LiveSessionController } from "../src/extensions/live/controller.js";
import type {
  LiveMediaConnection,
  LivePairingServer,
} from "../src/extensions/live/pairing/server.js";
import {
  getLiveSessionCoordinator,
  type LiveSessionThreadRuntime,
} from "../src/live-session/coordinator.js";
import {
  createSubagentParentMessageTool,
  type SubagentParentMessage,
} from "../src/subagent-sdk/parent-message.js";
import type { SubagentChildIpcEvent } from "../src/subagent-sdk/ipc.js";
import type { RuntimeSubagent } from "../src/subagent-sdk/types.js";

function runtimeState(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    event: "started",
    sessionId: "child-1",
    parentSessionId: "parent-1",
    name: "worker",
    modeLabel: "worker",
    cwd: "/workspace",
    paneId: "%1",
    task: "Inspect integration flow",
    handoff: false,
    autoExit: true,
    status: "running",
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

class ParentMessageRuntime implements LiveSessionThreadRuntime {
  parentMessageListener: ((sessionId: string, message: SubagentParentMessage) => void) | undefined;
  stateListener: ((state: RuntimeSubagent) => void) | undefined;

  list(): RuntimeSubagent[] {
    return [runtimeState()];
  }

  message(): Promise<RuntimeSubagent> {
    return Promise.resolve(runtimeState());
  }

  interrupt(): Promise<RuntimeSubagent> {
    return Promise.resolve(runtimeState());
  }

  onState(listener: (state: RuntimeSubagent) => void): () => void {
    this.stateListener = listener;
    return () => {
      this.stateListener = undefined;
    };
  }

  onChildEvent(_listener: (sessionId: string, event: SubagentChildIpcEvent) => void): () => void {
    return () => {};
  }

  onParentMessage(
    listener: (sessionId: string, message: SubagentParentMessage) => void,
  ): () => void {
    this.parentMessageListener = listener;
    return () => {
      this.parentMessageListener = undefined;
    };
  }
}

interface TestLiveConnection extends LiveMediaConnection {
  notifications: Array<{ method: string; params: unknown }>;
  emitState(state: "connected" | "reconnecting"): void;
}

function createLiveConnection(): TestLiveConnection {
  let notificationListener: ((method: string, params: unknown) => void) | undefined;
  let stateListener: ((state: "connected" | "reconnecting") => void) | undefined;
  const notifications: Array<{ method: string; params: unknown }> = [];
  return {
    notifications,
    open: true,
    onNotification(listener) {
      notificationListener = listener;
    },
    onRequest() {},
    onClose() {},
    onState(listener) {
      stateListener = listener;
    },
    notify(method, params) {
      notifications.push({ method, params });
    },
    request(method) {
      if (method === "webrtc.createOffer") {
        notificationListener?.("webrtc.opened", {});
        return Promise.resolve({ sdp: "offer-sdp" });
      }
      if (method === "codex.createAttestation") {
        return Promise.resolve({
          supported: false,
          locale: "en-US",
          timezone: "UTC",
          appSessionId: "test-app-session",
        });
      }
      if (method === "webrtc.acceptAnswer") return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected live request: ${method}`));
    },
    close() {},
    emitState(state) {
      stateListener?.(state);
    },
  } as TestLiveConnection;
}

function createExtensionApi(events: EventEmitter, sentMessages: unknown[]): ExtensionAPI {
  return {
    events,
    sendMessage(message: unknown) {
      sentMessages.push(message);
    },
    appendEntry() {},
  } as unknown as ExtensionAPI;
}

afterEach(() => {
  liveControlMessages.length = 0;
  liveControlSessionIds.length = 0;
});

describe("live child parent-message integration", () => {
  it("speaks an explicit result and identical completion summary exactly once", async () => {
    const sharedSessionEvents = new EventEmitter();
    const parentMessages: unknown[] = [];
    const extensionApi = createExtensionApi(sharedSessionEvents, parentMessages);
    const coordinator = getLiveSessionCoordinator(extensionApi);
    const runtime = new ParentMessageRuntime();
    coordinator.bindThreadRuntime(runtime, extensionApi);
    const connection = createLiveConnection();
    const controller = new LiveSessionController({
      pi: extensionApi,
      context: {
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => "parent-1",
          getBranch: () => [],
        },
      } as unknown as ExtensionContext,
      pairing: {
        accept: () => Promise.resolve(connection),
        close: () => Promise.resolve(),
      } as unknown as LivePairingServer,
      coordinator,
      identity: { name: "Pi", email: "pi@example.com" },
      appOpenTimeoutMs: 1_000,
      callbacks: {
        onPhase() {},
        onLevels() {},
        onTranscript() {},
        onAgentFailure() {},
        onTerminal() {},
      },
    });

    await controller.start();
    liveControlMessages.length = 0;
    runtime.parentMessageListener?.("child-1", {
      kind: "result",
      message: "Implemented X; tests pass",
      delivery: "steer",
      createdAt: 2,
    });
    runtime.stateListener?.(
      runtimeState({
        event: "completed",
        status: "completed",
        summary: "Implemented X; tests pass",
        updatedAt: 3,
        completedAt: 3,
      }),
    );

    await vi.waitFor(() => {
      expect(
        liveControlMessages.filter((message) =>
          JSON.stringify(message).includes("Implemented X; tests pass"),
        ),
      ).toHaveLength(1);
    });
    expect(coordinator.inspectThread("child-1")).toMatchObject({
      thread: { status: "completed", finalSummary: "Implemented X; tests pass" },
      events: [
        { type: "thread.started" },
        { type: "thread.message" },
        { type: "thread.status" },
        { type: "thread.completed" },
      ],
    });

    await controller.stop();
  });

  it("does not speak automatic terminal summaries when completion is false", async () => {
    const sharedSessionEvents = new EventEmitter();
    const parentMessages: unknown[] = [];
    const extensionApi = createExtensionApi(sharedSessionEvents, parentMessages);
    const coordinator = getLiveSessionCoordinator(extensionApi);
    const runtime = new ParentMessageRuntime();
    runtime.list = () => [runtimeState({ completion: false })];
    coordinator.bindThreadRuntime(runtime, extensionApi);
    const connection = createLiveConnection();
    const controller = new LiveSessionController({
      pi: extensionApi,
      context: {
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => "parent-1",
          getBranch: () => [],
        },
      } as unknown as ExtensionContext,
      pairing: {
        accept: () => Promise.resolve(connection),
        close: () => Promise.resolve(),
      } as unknown as LivePairingServer,
      coordinator,
      identity: { name: "Pi", email: "pi@example.com" },
      appOpenTimeoutMs: 1_000,
      callbacks: {
        onPhase() {},
        onLevels() {},
        onTranscript() {},
        onAgentFailure() {},
        onTerminal() {},
      },
    });

    await controller.start();
    liveControlMessages.length = 0;
    runtime.stateListener?.(
      runtimeState({
        event: "completed",
        status: "completed",
        completion: false,
        summary: "Structured result already returned",
        updatedAt: 3,
        completedAt: 3,
      }),
    );

    await vi.waitFor(() => {
      expect(coordinator.inspectThread("child-1")?.thread).toMatchObject({
        status: "completed",
        finalSummary: "Structured result already returned",
      });
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(parentMessages).toEqual([]);
    expect(
      liveControlMessages.filter((message) =>
        JSON.stringify(message).includes("Structured result already returned"),
      ),
    ).toEqual([]);
    expect(coordinator.inspectThread("child-1")?.events).toContainEqual(
      expect.objectContaining({
        type: "thread.completed",
        data: expect.objectContaining({ completionNotificationEnabled: false }),
      }),
    );
    expect(connection.notifications).toContainEqual(
      expect.objectContaining({ method: "thread.completed" }),
    );
    await controller.stop();
  });

  it("preserves distinct message and completion speech semantics", async () => {
    const sharedSessionEvents = new EventEmitter();
    const parentMessages: unknown[] = [];
    const extensionApi = createExtensionApi(sharedSessionEvents, parentMessages);
    const coordinator = getLiveSessionCoordinator(extensionApi);
    const runtime = new ParentMessageRuntime();
    coordinator.bindThreadRuntime(runtime, extensionApi);
    const controller = new LiveSessionController({
      pi: extensionApi,
      context: {
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => "parent-1",
          getBranch: () => [],
        },
      } as unknown as ExtensionContext,
      pairing: {
        accept: () => Promise.resolve(createLiveConnection()),
        close: () => Promise.resolve(),
      } as unknown as LivePairingServer,
      coordinator,
      identity: { name: "Pi", email: "pi@example.com" },
      appOpenTimeoutMs: 1_000,
      callbacks: {
        onPhase() {},
        onLevels() {},
        onTranscript() {},
        onAgentFailure() {},
        onTerminal() {},
      },
    });

    await controller.start();
    liveControlMessages.length = 0;

    runtime.parentMessageListener?.("child-1", {
      kind: "progress",
      message: "Shared progress text",
      delivery: "steer",
      createdAt: 2,
    });
    runtime.stateListener?.(
      runtimeState({
        event: "completed",
        status: "completed",
        summary: "Shared progress text",
        updatedAt: 3,
        completedAt: 3,
      }),
    );

    runtime.stateListener?.(runtimeState({ event: "resumed", updatedAt: 4 }));
    runtime.parentMessageListener?.("child-1", {
      kind: "result",
      message: "Interim explicit result",
      delivery: "steer",
      createdAt: 5,
    });
    runtime.stateListener?.(
      runtimeState({
        event: "completed",
        status: "completed",
        summary: "Different final summary",
        updatedAt: 6,
        completedAt: 6,
      }),
    );

    runtime.stateListener?.(runtimeState({ event: "resumed", completion: false, updatedAt: 7 }));
    runtime.parentMessageListener?.("child-1", {
      kind: "result",
      message: "Explicit result stays speakable",
      delivery: "steer",
      createdAt: 8,
    });
    runtime.stateListener?.(
      runtimeState({
        event: "completed",
        status: "completed",
        completion: false,
        summary: "Silent automatic completion",
        updatedAt: 9,
        completedAt: 9,
      }),
    );

    runtime.stateListener?.(runtimeState({ event: "resumed", updatedAt: 10 }));
    runtime.stateListener?.(
      runtimeState({
        event: "completed",
        status: "completed",
        summary: "Normal automatic completion",
        updatedAt: 11,
        completedAt: 11,
      }),
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const speechCount = (text: string): number =>
      liveControlMessages.filter((message) => JSON.stringify(message).includes(text)).length;
    expect(speechCount("Shared progress text")).toBe(2);
    expect(speechCount("Interim explicit result")).toBe(1);
    expect(speechCount("Different final summary")).toBe(1);
    expect(speechCount("Explicit result stays speakable")).toBe(1);
    expect(speechCount("Silent automatic completion")).toBe(0);
    expect(speechCount("Normal automatic completion")).toBe(1);
    expect(parentMessages).toHaveLength(3);

    await controller.stop();
  });

  it("forwards a child custom message through the parent coordinator to the active voice agent", async () => {
    const sharedSessionEvents = new EventEmitter();
    const parentMessages: unknown[] = [];
    const liveExtensionApi = createExtensionApi(sharedSessionEvents, parentMessages);
    const subagentExtensionApi = createExtensionApi(sharedSessionEvents, parentMessages);
    const liveCoordinator = getLiveSessionCoordinator(liveExtensionApi);
    const subagentCoordinator = getLiveSessionCoordinator(subagentExtensionApi);
    const unrelatedCoordinator = getLiveSessionCoordinator(
      createExtensionApi(new EventEmitter(), []),
    );
    const unrelatedEvents: unknown[] = [];
    const unsubscribeUnrelated = unrelatedCoordinator.subscribe((event) => {
      unrelatedEvents.push(event);
    });
    const runtime = new ParentMessageRuntime();
    subagentCoordinator.bindThreadRuntime(runtime, subagentExtensionApi);

    const connection = createLiveConnection();
    const pairing = {
      accept: () => Promise.resolve(connection),
      close: () => Promise.resolve(),
    } as unknown as LivePairingServer;
    const context = {
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "parent-1",
        getBranch: () => [],
      },
    } as unknown as ExtensionContext;
    const controller = new LiveSessionController({
      pi: liveExtensionApi,
      context,
      pairing,
      coordinator: liveCoordinator,
      identity: { name: "Pi", email: "pi@example.com" },
      appOpenTimeoutMs: 1_000,
      callbacks: {
        onPhase() {},
        onLevels() {},
        onTranscript() {},
        onAgentFailure() {},
        onTerminal() {},
      },
    });

    await controller.start();
    expect(liveControlSessionIds).toEqual(["parent-1"]);
    liveControlMessages.length = 0;
    const childTool = createSubagentParentMessageTool((message) => {
      runtime.parentMessageListener?.("child-1", message);
    }) as ToolDefinition<any, any>;

    await childTool.execute(
      "message-parent",
      {
        action: "message",
        target: "parent",
        kind: "progress",
        message: "Focused regression now passes",
      },
      undefined,
      undefined,
      context,
    );

    await vi.waitFor(() => {
      expect(parentMessages).toHaveLength(1);
      expect(liveControlMessages).toContainEqual({
        type: "session.context.append",
        channel: "speakable",
        content: [
          {
            type: "input_text",
            text: expect.stringContaining("Focused regression now passes"),
          },
        ],
      });
    });
    expect(
      liveControlMessages.filter((message) =>
        JSON.stringify(message).includes("Focused regression now passes"),
      ),
    ).toHaveLength(1);
    expect(unrelatedEvents).toEqual([]);

    controller.handleMessageStart({
      role: "custom",
      customType: "live-delegation",
      details: { delegationId: "delegation-1" },
    });
    connection.emitState("reconnecting");
    connection.emitState("connected");
    expect(
      connection.notifications.filter(({ method }) => method === "activity.snapshot").at(-1),
    ).toMatchObject({
      method: "activity.snapshot",
      params: { state: "checkingSubagents" },
    });
    liveControlMessages.length = 0;
    await childTool.execute(
      "message-parent-reconnecting",
      {
        action: "message",
        target: "parent",
        kind: "progress",
        message: "Reconnect-safe progress",
      },
      undefined,
      undefined,
      context,
    );

    await vi.waitFor(() => {
      expect(parentMessages).toHaveLength(2);
      expect(liveControlMessages).toEqual([
        {
          type: "delegation.context.append",
          delegation_item_id: "delegation-1",
          channel: "speakable",
          content: [
            {
              type: "input_text",
              text: expect.stringContaining("Reconnect-safe progress"),
            },
          ],
        },
      ]);
    });

    unsubscribeUnrelated();
    await controller.stop();
    liveControlMessages.length = 0;
    await childTool.execute(
      "message-parent-stopped",
      {
        action: "message",
        target: "parent",
        kind: "progress",
        message: "Stopped sessions stay silent",
      },
      undefined,
      undefined,
      context,
    );
    expect(parentMessages).toHaveLength(3);
    expect(liveControlMessages).toEqual([]);
  });

  it("does not send voice protocol messages without a live controller", async () => {
    const parentMessages: unknown[] = [];
    const extensionApi = createExtensionApi(new EventEmitter(), parentMessages);
    const coordinator = getLiveSessionCoordinator(extensionApi);
    const runtime = new ParentMessageRuntime();
    coordinator.bindThreadRuntime(runtime, extensionApi);
    const childTool = createSubagentParentMessageTool((message) => {
      runtime.parentMessageListener?.("child-1", message);
    }) as ToolDefinition<any, any>;

    await childTool.execute(
      "message-parent-no-live",
      {
        action: "message",
        target: "parent",
        kind: "progress",
        message: "Parent-only update",
      },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(parentMessages).toHaveLength(1);
    expect(liveControlMessages).toEqual([]);
  });
});
