import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  LiveSessionCoordinator,
  type LiveSessionThreadRuntime,
} from "../src/live-session/coordinator.js";
import { connectSubagentIpcClient, createSubagentIpcServer } from "../src/subagent-sdk/ipc.js";
import type { SubagentChildIpcEvent } from "../src/subagent-sdk/ipc.js";
import {
  createSubagentParentMessageTool,
  type SubagentParentMessage,
} from "../src/subagent-sdk/parent-message.js";
import type { RuntimeSubagent } from "../src/subagent-sdk/types.js";

function runtimeState(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    event: "started",
    sessionId: "child-1",
    parentSessionId: "parent-1",
    name: "tests",
    modeLabel: "worker",
    cwd: "/workspace",
    paneId: "%1",
    task: "Run tests",
    handoff: false,
    autoExit: true,
    status: "running",
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

class FakeThreadRuntime implements LiveSessionThreadRuntime {
  readonly states = [runtimeState()];
  stateListener: ((state: RuntimeSubagent) => void) | undefined;
  parentMessageListener: ((sessionId: string, message: SubagentParentMessage) => void) | undefined;
  childEventListener: ((sessionId: string, event: SubagentChildIpcEvent) => void) | undefined;

  list(): RuntimeSubagent[] {
    return this.states;
  }

  message(): Promise<RuntimeSubagent> {
    return Promise.resolve(this.states[0]!);
  }

  interrupt(): Promise<RuntimeSubagent> {
    return Promise.resolve(this.states[0]!);
  }

  onState(listener: (state: RuntimeSubagent) => void): () => void {
    this.stateListener = listener;
    return () => {
      this.stateListener = undefined;
    };
  }

  onChildEvent(listener: Parameters<LiveSessionThreadRuntime["onChildEvent"]>[0]): () => void {
    this.childEventListener = listener;
    return () => {
      this.childEventListener = undefined;
    };
  }

  onParentMessage(
    listener: (sessionId: string, message: SubagentParentMessage) => void,
  ): () => void {
    this.parentMessageListener = listener;
    return () => {
      this.parentMessageListener = undefined;
    };
  }

  emitChildEvent(sessionId: string, delta: string): void {
    this.childEventListener?.(sessionId, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta, partial: {} },
    } as never);
  }
}

describe("LiveSessionCoordinator", () => {
  it("steers explicit child messages to parent and records ordered activity", () => {
    const sentMessages: Array<{ message: unknown; options: unknown }> = [];
    const pi = {
      sendMessage(message: unknown, options: unknown) {
        sentMessages.push({ message, options });
      },
    } as ExtensionAPI;
    const runtime = new FakeThreadRuntime();
    const coordinator = new LiveSessionCoordinator(pi);
    coordinator.bindThreadRuntime(runtime);
    coordinator.setRootSession({
      sessionId: "parent-1",
      name: "Pi",
      cwd: "/workspace",
      updatedAt: 1,
    });

    runtime.parentMessageListener?.("child-1", {
      kind: "blocker",
      message: "Tests cannot start without credentials",
      delivery: "steer",
      createdAt: 2,
    });

    expect(sentMessages).toEqual([
      {
        message: expect.objectContaining({
          customType: "subagent-parent-message",
          content: "Tests cannot start without credentials",
          display: true,
        }),
        options: { triggerTurn: true, deliverAs: "steer" },
      },
    ]);
    expect(coordinator.listThreads()).toEqual([
      expect.objectContaining({ id: "parent-1", path: "/root", status: "idle" }),
      expect.objectContaining({ id: "child-1", path: "/root/tests", status: "running" }),
    ]);
    expect(coordinator.inspectThread("child-1")?.events).toEqual([
      expect.objectContaining({ sequence: 1, type: "thread.started", threadId: "child-1" }),
      expect.objectContaining({ sequence: 2, type: "thread.message", threadId: "child-1" }),
    ]);
    expect(coordinator.snapshot()).toMatchObject({
      sequence: 2,
      threads: [
        { id: "parent-1", path: "/root" },
        { id: "child-1", path: "/root/tests" },
      ],
    });
    expect(coordinator.buildSessionSummary()).toContain(
      "tests: running — Run tests — Tests cannot start without credentials",
    );
  });

  it("delivers authenticated parent messages over child IPC", async () => {
    const server = createSubagentIpcServer();
    const config = server.createRoute("child-1");
    const client = connectSubagentIpcClient({ sessionId: "child-1", config });
    try {
      const received = new Promise<{ sessionId: string; message: SubagentParentMessage }>(
        (resolve) => {
          server.onParentMessage(resolve);
        },
      );
      client.emitParentMessage({
        kind: "progress",
        message: "Running integration tests",
        delivery: "steer",
        createdAt: 3,
      });

      await expect(received).resolves.toEqual({
        sessionId: "child-1",
        message: {
          kind: "progress",
          message: "Running integration tests",
          delivery: "steer",
          createdAt: 3,
        },
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });

  it("gives child sessions one subagent action that steers parent by default", async () => {
    const messages: SubagentParentMessage[] = [];
    const tool = createSubagentParentMessageTool((message) =>
      messages.push(message),
    ) as ToolDefinition<any, any>;

    const result = await tool.execute(
      "message-parent",
      {
        action: "message",
        target: "parent",
        kind: "blocker",
        message: "Need product decision",
      },
      undefined,
      undefined,
      {} as ExtensionContext,
    );

    expect(messages).toEqual([
      {
        kind: "blocker",
        message: "Need product decision",
        delivery: "steer",
        createdAt: expect.any(Number),
      },
    ]);
    expect(result.content[0]?.text).toMatch(/steered parent/i);
    expect(tool.description).toMatch(/explicit.*parent/i);
  });

  it("batches child commentary before publishing thread updates", () => {
    vi.useFakeTimers();
    try {
      const coordinator = new LiveSessionCoordinator({ sendMessage() {} } as ExtensionAPI);
      const runtime = new FakeThreadRuntime();
      coordinator.bindThreadRuntime(runtime);
      const events: string[] = [];
      coordinator.subscribe((event) => {
        if (event.type === "thread.commentary" && typeof event.data.text === "string") {
          events.push(event.data.text);
        }
      });

      runtime.emitChildEvent("child-1", "Checking ");
      runtime.emitChildEvent("child-1", "tests");
      vi.advanceTimersByTime(199);
      expect(events).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(events).toEqual(["Checking tests"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
