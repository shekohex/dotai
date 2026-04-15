import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { createSubagentSDK } from "../src/subagent-sdk/sdk.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";
import { SUBAGENT_STRUCTURED_OUTPUT_ENTRY } from "../src/subagent-sdk/types.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

async function waitForCondition(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
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

    assert.equal(started.ok, true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    const handle = started.value.handle;
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

    assert.equal(started.ok, true);
    if (!started.ok) {
      throw new Error(started.error.message);
    }

    const handle = started.value.handle;
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

    const started = await sdk.spawn(
      {
        name: "worker-one",
        task: "Inspect the failing tests",
        mode: "reviewer",
      },
      ctx,
    );
    assert.equal(started.ok, true);

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

timedTest(
  "SubagentSDK spawn returns structured outcome for json_schema output format",
  async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-sdk-structured-dir-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-sdk-structured-cwd-"));
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

      const spawnPromise = sdk.spawn(
        {
          name: "worker-one",
          task: "Return a structured summary",
          mode: "reviewer",
          outputFormat: {
            type: "json_schema",
            schema: Type.Object({
              summary: Type.String(),
              risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
            }),
          },
        },
        ctx,
      );

      await waitForCondition(() => sdk.list().length === 1);
      const running = sdk.list()[0];
      assert.ok(running);

      const timestamp = new Date().toISOString();
      await fs.appendFile(
        running.sessionPath,
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
              content: [{ type: "text", text: "Structured summary complete" }],
            },
          }),
          JSON.stringify({
            type: "custom",
            id: "c1",
            parentId: "a1",
            timestamp,
            customType: SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
            data: {
              status: "captured",
              attempts: 1,
              retryCount: 3,
              structured: { summary: "All good", risk: "low" },
              updatedAt: Date.now(),
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      fakeMux.existingPanes.delete(running.paneId);

      const started = await spawnPromise;
      assert.equal(started.ok, true);
      if (!started.ok) {
        throw new Error(started.error.message);
      }

      assert.deepEqual(started.value.structured, { summary: "All good", risk: "low" });
      assert.deepEqual(started.value.state.structured, { summary: "All good", risk: "low" });
      assert.equal(started.value.state.status, "completed");
    } finally {
      sdk.dispose();
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest(
  "SubagentSDK spawn returns typed error outcome for structured output failure",
  async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-subagent-sdk-structured-error-dir-"),
    );
    const cwd = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-subagent-sdk-structured-error-cwd-"),
    );
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

      const spawnPromise = sdk.spawn(
        {
          name: "worker-one",
          task: "Return a structured summary",
          mode: "reviewer",
          outputFormat: {
            type: "json_schema",
            retryCount: 2,
            schema: Type.Object({ summary: Type.String() }),
          },
        },
        ctx,
      );

      await waitForCondition(() => sdk.list().length === 1);
      const running = sdk.list()[0];
      assert.ok(running);

      const timestamp = new Date().toISOString();
      await fs.appendFile(
        running.sessionPath,
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
              content: [{ type: "text", text: "Done" }],
            },
          }),
          JSON.stringify({
            type: "custom",
            id: "c1",
            parentId: "a1",
            timestamp,
            customType: SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
            data: {
              status: "error",
              attempts: 2,
              retryCount: 2,
              error: {
                code: "validation_failed",
                message: "Structured output validation failed and retry budget was exhausted.",
                retryCount: 2,
                attempts: 2,
                lastValidationError: "Expected object",
              },
              updatedAt: Date.now(),
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      fakeMux.existingPanes.delete(running.paneId);

      const started = await spawnPromise;
      assert.equal(started.ok, false);
      if (started.ok) {
        throw new Error("Expected structured spawn to fail");
      }

      assert.equal(started.error.code, "validation_failed");
      assert.equal(started.error.retryCount, 2);
      assert.equal(started.error.attempts, 2);
    } finally {
      sdk.dispose();
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);
