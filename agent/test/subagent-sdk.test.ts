import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { createSubagentSDK } from "../src/subagent-sdk/sdk.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

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
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".pi", "modes.json"),
      `${JSON.stringify(
        {
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
        },
        null,
        2,
      )}\n`,
      "utf8",
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

    const handle = started.handle;
    assert.equal(handle.getState().status, "running");
    assert.equal(sdk.get(handle.sessionId)?.sessionId, handle.sessionId);

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

    const completed = await handle.waitForCompletion();
    assert.equal(completed.status, "completed");
    assert.equal(completed.summary, "Finished successfully");

    stopListening();
    assert.match(events.join("\n"), /started:running/);
    assert.match(events.join("\n"), /completed:completed/);
  } finally {
    sdk.dispose();
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
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".pi", "modes.json"),
      `${JSON.stringify(
        {
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
        },
        null,
        2,
      )}\n`,
      "utf8",
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

    const handle = started.handle;
    const listState = sdk.list()[0];
    const handleState = handle.getState();
    assert.ok(listState);

    listState.status = "failed";
    listState.paneId = "%999";
    handleState.status = "cancelled";
    handleState.autoExitDeadlineAt = 1;

    const refreshedListState = sdk.list()[0];
    const refreshedHandleState = handle.getState();
    assert.ok(refreshedListState);
    assert.equal(refreshedListState.status, "running");
    assert.equal(refreshedHandleState.status, "running");
    assert.notEqual(refreshedListState.paneId, "%999");
    assert.equal(refreshedHandleState.autoExitDeadlineAt, undefined);
  } finally {
    sdk.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("SubagentSDK onEvent deduplicates repeated poll-only updatedAt churn", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-sdk-events-dir-"));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-sdk-events-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const sdk = createSubagentSDK(fakePi as unknown as ExtensionAPI, {
    adapter: fakeMux,
    buildLaunchCommand: () => "pi --session fake",
  });

  try {
    await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".pi", "modes.json"),
      `${JSON.stringify(
        {
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
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const ctx = createFakeContext({
      cwd,
      sessionFile: path.join(cwd, "parent.jsonl"),
    });
    const events: string[] = [];
    const stopListening = sdk.onEvent((event) => {
      events.push(`${event.type}:${event.state.status}`);
    });

    await sdk.spawn(
      {
        name: "worker-one",
        task: "Inspect the failing tests",
        mode: "reviewer",
      },
      ctx,
    );

    await new Promise((resolve) => setTimeout(resolve, 4_300));

    stopListening();
    assert.deepEqual(events, ["started:running", "updated:running"]);
  } finally {
    sdk.dispose();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
