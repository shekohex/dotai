import { afterEach, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defineModesFile,
  registerBuiltInModes,
  unregisterBuiltInModes,
} from "../src/mode-utils.ts";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSubagentSDK } from "../src/subagent-sdk/sdk.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";
import { SUBAGENT_STRUCTURED_OUTPUT_ENTRY } from "../src/subagent-sdk/types.ts";
import { createTempDir } from "./test-utils/temp-paths.ts";

const TEST_TIMEOUT_MS = 15_000;
const TEST_MODE_SOURCE = "test-subagent-sdk-message";

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

timedTest("message auto-resume uses new message as task not original task", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempDir("agent-subagent-sdk-message-dir-");
  const cwd = await createTempDir("agent-subagent-sdk-message-cwd-");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const launchedTasks: string[] = [];
  const sdk = createSubagentSDK(fakePi as unknown as ExtensionAPI, {
    adapter: fakeMux,
    buildLaunchCommand: (_state, childState, prompt, _options) => {
      launchedTasks.push(prompt);
      return "pi --session fake";
    },
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

    // Start the subagent with initial task
    const started = await sdk.start(
      {
        name: "worker-one",
        task: "Research topic X",
        mode: "reviewer",
      },
      ctx,
    );

    expect(launchedTasks).toEqual(["Research topic X"]);
    expect(fakeMux.created.length).toBe(1);

    const sessionId = started.handle.sessionId;

    // Simulate subagent completing - write session outcome and kill pane
    const state = sdk.list()[0];
    const timestamp = new Date().toISOString();
    await fs.appendFile(
      state.sessionPath,
      [
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp,
          message: { role: "user", content: [{ type: "text", text: "Research topic X" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Done researching topic X" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    fakeMux.existingPanes.delete(state.paneId);

    // Wait for polling to finalize the subagent (poll interval is 250ms)
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await waitForCondition(() => sdk.list()[0].status === "completed");

    // Reset capture for verify next launch
    launchedTasks.length = 0;
    fakeMux.created.length = 0;
    fakeMux.sent.length = 0;

    // Message the completed subagent with a new task
    const messageResult = await sdk.message(
      {
        sessionId,
        message: "Now research topic Y instead",
        delivery: "steer",
      },
      ctx,
    );

    expect(messageResult.result.autoResumed).toBe(true);
    // resumePrompt is the new message, not the original task
    expect(messageResult.result.resumePrompt).toBe("Now research topic Y instead");

    expect(launchedTasks).toEqual(["Now research topic Y instead"]);

    // sendText is NOT called when auto-resumed because the message was
    // already delivered as the child's initial prompt via resume().
    // This avoids duplicate input to the child session.
    expect(fakeMux.sent.length).toBe(0);
  } finally {
    sdk.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("message to live subagent sends directly without resume", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempDir("agent-subagent-sdk-message-live-dir-");
  const cwd = await createTempDir("agent-subagent-sdk-message-live-cwd-");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  let launchCount = 0;
  const sdk = createSubagentSDK(fakePi as unknown as ExtensionAPI, {
    adapter: fakeMux,
    buildLaunchCommand: () => {
      launchCount++;
      return "pi --session fake";
    },
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

    const started = await sdk.start(
      {
        name: "worker-one",
        task: "Research topic X",
        mode: "reviewer",
      },
      ctx,
    );

    const sessionId = started.handle.sessionId;
    expect(launchCount).toBe(1);

    // Message the live (running) subagent
    fakeMux.sent.length = 0;
    const messageResult = await sdk.message(
      {
        sessionId,
        message: "Actually, focus on topic Z",
        delivery: "steer",
      },
      ctx,
    );

    expect(messageResult.result.autoResumed).toBe(false);
    expect(launchCount).toBe(1); // No new launch

    // Verify sendText was called directly
    const sendTextCall = fakeMux.sent.find((s) => s.text === "Actually, focus on topic Z");
    expect(sendTextCall).toBeTruthy();
    expect(sendTextCall!.submitMode).toBe("steer");
  } finally {
    sdk.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
