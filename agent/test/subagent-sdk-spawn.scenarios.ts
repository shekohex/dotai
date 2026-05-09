import { afterEach, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import {
  defineModesFile,
  registerBuiltInModes,
  unregisterBuiltInModes,
} from "../src/mode-utils.ts";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSubagentSDK } from "../src/subagent-sdk/sdk.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";
import { SUBAGENT_STRUCTURED_OUTPUT_ENTRY } from "../src/subagent-sdk/types.ts";

const TEST_TIMEOUT_MS = 15_000;
const TEST_MODE_SOURCE = "test-subagent-sdk-reviewer";

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

afterEach(() => {
  unregisterBuiltInModes(TEST_MODE_SOURCE);
});

async function waitForCondition(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeMuxAdapter implements MuxAdapter {
  readonly backend = "tmux";
  readonly created: Array<{
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
    paneId: string;
  }> = [];
  readonly sent: Array<{ paneId: string; text: string; submitMode?: PaneSubmitMode }> = [];
  readonly killed: string[] = [];
  readonly existingPanes = new Set<string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createPane(options: {
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
  }): Promise<{ paneId: string }> {
    const paneId = `%${this.created.length + 1}`;
    this.created.push({ ...options, paneId });
    this.existingPanes.add(paneId);
    return { paneId };
  }

  async sendText(paneId: string, text: string, submitMode?: PaneSubmitMode): Promise<void> {
    this.sent.push({ paneId, text, submitMode });
  }

  async paneExists(paneId: string): Promise<boolean> {
    return this.existingPanes.has(paneId);
  }

  async killPane(paneId: string): Promise<void> {
    this.killed.push(paneId);
    this.existingPanes.delete(paneId);
  }

  async capturePane(): Promise<{ text: string }> {
    return { text: "" };
  }
}

class FakePi implements Partial<ExtensionAPI> {
  activeTools = ["read", "bash", "subagent", "session_query"];
  allTools = this.activeTools.map((name) => ({ name }));
  appendedEntries: Array<{ customType: string; data: unknown }> = [];
  sentMessages: Array<{ message: unknown; options: unknown }> = [];

  appendEntry(customType: string, data?: unknown): void {
    this.appendedEntries.push({ customType, data });
  }

  sendMessage(message: unknown, options?: unknown): void {
    this.sentMessages.push({ message, options });
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  getAllTools(): Array<{ name: string }> {
    return [...this.allTools];
  }

  setActiveTools(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  setSessionName(): void {}
}

function createFakeContext(options: {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
}): ExtensionContext {
  return {
    cwd: options.cwd,
    hasUI: false,
    ui: {
      setWidget() {},
      notify() {},
      onTerminalInput(handler: (data: string) => unknown) {
        return handler;
      },
    },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "parent-session-id",
      getSessionFile: () => options.sessionFile,
      getEntries: () => [],
      getBranch: () => [],
    },
    shutdown() {},
  } as unknown as ExtensionContext;
}

timedTest("SubagentSDK exposes handles and completion events", async () => {
  vi.useFakeTimers();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-sdk-dir-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-sdk-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const sdk = createSubagentSDK(fakePi as unknown as ExtensionAPI, {
    adapter: fakeMux,
    buildLaunchCommand: () => "pi --session fake",
  });

  try {
    registerBuiltInModes(
      TEST_MODE_SOURCE,
      defineModesFile({
        version: 1,
        modes: {
          reviewer: {
            provider: "mode-provider",
            modelId: "review-model",
            tools: ["read"],
            autoExit: true,
            tmuxTarget: "window",
          },
        },
      }),
    );

    const ctx = createFakeContext({
      cwd,
      sessionFile: path.join(cwd, "parent.jsonl"),
    });
    const events: string[] = [];
    const stopListening = sdk.onEvent((event) => {
      events.push(`${event.type}:${event.state.status}`);
    });

    const started = await sdk.spawn(
      {
        name: "worker-one",
        task: "Inspect the failing tests",
        mode: "reviewer",
      },
      ctx,
    );

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    const handle = started.value.handle;
    expect(handle.getState().status).toBe("running");
    expect(sdk.get(handle.sessionId)?.sessionId).toBe(handle.sessionId);

    const sessionPath = handle.getState().sessionPath;
    const timestamp = new Date().toISOString();
    await fs.appendFile(
      sessionPath,
      [
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp,
          message: { role: "user", content: [{ type: "text", text: "Do work" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Finished successfully" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );
    fakeMux.existingPanes.delete(handle.getState().paneId);

    const completionPromise = handle.waitForCompletion();
    await vi.advanceTimersByTimeAsync(2_500);
    const completed = await completionPromise;
    expect(completed.status).toBe("completed");
    expect(completed.summary).toBe("Finished successfully");

    stopListening();
    expect(events.join("\n")).toMatch(/started:running/);
    expect(events.join("\n")).toMatch(/completed:completed/);
  } finally {
    sdk.dispose();
    vi.useRealTimers();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("SubagentSDK state access returns snapshots, not mutable internals", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-sdk-snapshots-dir-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-sdk-snapshots-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const sdk = createSubagentSDK(fakePi as unknown as ExtensionAPI, {
    adapter: fakeMux,
    buildLaunchCommand: () => "pi --session fake",
  });

  try {
    registerBuiltInModes(
      TEST_MODE_SOURCE,
      defineModesFile({
        version: 1,
        modes: {
          reviewer: {
            provider: "mode-provider",
            modelId: "review-model",
            tools: ["read"],
            autoExit: true,
            tmuxTarget: "window",
          },
        },
      }),
    );

    const ctx = createFakeContext({
      cwd,
      sessionFile: path.join(cwd, "parent.jsonl"),
    });

    const started = await sdk.spawn(
      {
        name: "worker-one",
        task: "Inspect the failing tests",
        mode: "reviewer",
      },
      ctx,
    );

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    const handle = started.value.handle;
    const listState = sdk.list()[0];
    const handleState = handle.getState();
    expect(listState).toBeTruthy();

    listState.status = "failed";
    listState.paneId = "%999";
    handleState.status = "cancelled";
    handleState.autoExitDeadlineAt = 1;

    const refreshedListState = sdk.list()[0];
    const refreshedHandleState = handle.getState();
    expect(refreshedListState).toBeTruthy();
    expect(refreshedListState.status).toBe("running");
    expect(refreshedHandleState.status).toBe("running");
    expect(refreshedListState.paneId).not.toBe("%999");
    expect(refreshedHandleState.autoExitDeadlineAt).toBe(undefined);
  } finally {
    sdk.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
