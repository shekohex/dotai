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

function runtimeState(): RuntimeSubagent {
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
  };
}

class ParentMessageRuntime implements LiveSessionThreadRuntime {
  parentMessageListener: ((sessionId: string, message: SubagentParentMessage) => void) | undefined;

  list(): RuntimeSubagent[] {
    return [runtimeState()];
  }

  message(): Promise<RuntimeSubagent> {
    return Promise.resolve(runtimeState());
  }

  interrupt(): Promise<RuntimeSubagent> {
    return Promise.resolve(runtimeState());
  }

  onState(): () => void {
    return () => {};
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
  emitState(state: "connected" | "reconnecting"): void;
}

function createLiveConnection(): TestLiveConnection {
  let notificationListener: ((method: string, params: unknown) => void) | undefined;
  let stateListener: ((state: "connected" | "reconnecting") => void) | undefined;
  return {
    open: true,
    onNotification(listener) {
      notificationListener = listener;
    },
    onRequest() {},
    onClose() {},
    onState(listener) {
      stateListener = listener;
    },
    notify() {},
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
