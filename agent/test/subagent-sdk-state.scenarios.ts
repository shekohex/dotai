import { afterEach, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defineModesFile,
  registerBuiltInModes,
  unregisterBuiltInModes,
} from "../src/mode-utils.ts";
import { Type } from "typebox";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSubagentSDK } from "../src/subagent-sdk/sdk.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";
import { SUBAGENT_STRUCTURED_OUTPUT_ENTRY } from "../src/subagent-sdk/types.ts";
import { createTempDir } from "./test-utils/temp-paths.ts";

const TEST_TIMEOUT_MS = 15_000;
const TEST_MODE_SOURCE = "test-subagent-sdk-reviewer-state";

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

afterEach(() => {
  vi.useRealTimers();
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

timedTest("SubagentSDK onEvent deduplicates repeated poll-only updatedAt churn", async () => {
  vi.useFakeTimers();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempDir("agent-subagent-sdk-events-dir-");
  const cwd = await createTempDir("agent-subagent-sdk-events-cwd-");
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

    await vi.advanceTimersByTimeAsync(4_300);

    stopListening();
    expect(events).toEqual(["started:running", "updated:running"]);
  } finally {
    sdk.dispose();
    vi.useRealTimers();
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

timedTest("SubagentSDK resumes unknown process child from explicit sessionPath", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await createTempDir("agent-subagent-sdk-resume-dir-");
  const cwd = await createTempDir("agent-subagent-sdk-resume-cwd-");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const fakePi = new FakePi();
  const fakeMux = new FakeMuxAdapter();
  const sdk = createSubagentSDK(fakePi as unknown as ExtensionAPI, {
    adapter: fakeMux,
    buildLaunchCommand: (_state, _childState, _prompt, options) =>
      options.launchTarget?.kind === "session"
        ? `pi --session ${options.launchTarget.sessionPath}`
        : "pi",
  });

  try {
    registerBuiltInModes(
      TEST_MODE_SOURCE,
      defineModesFile({
        version: 1,
        modes: {
          worker: {
            provider: "mode-provider",
            modelId: "worker-model",
            tools: ["read"],
            autoExit: true,
            tmuxTarget: "window",
          },
        },
      }),
    );

    const sessionPath = path.join(cwd, "child.jsonl");
    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "child-session-id",
        timestamp: new Date().toISOString(),
        cwd,
      }) + "\n",
      "utf8",
    );
    const resumed = await sdk.resume(
      {
        sessionId: "child-session-id",
        sessionPath,
        name: "workflow fixer",
        task: "Continue fixing workflow issues",
        mode: "worker",
        cwd,
        autoExit: true,
        outputFormat: { type: "text" },
      },
      createFakeContext({ cwd }),
    );

    expect(resumed.handle.sessionId).toBe("child-session-id");
    expect(fakeMux.created[0]?.command).toContain(`--session ${sessionPath}`);
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
    const agentDir = await createTempDir("agent-subagent-sdk-structured-dir-");
    const cwd = await createTempDir("agent-subagent-sdk-structured-cwd-");
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
      expect(running).toBeTruthy();

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
      vi.useFakeTimers();

      await vi.advanceTimersByTimeAsync(2_500);
      const started = await spawnPromise;
      expect(started.ok).toBe(true);
      if (!started.ok) {
        throw new Error(started.error.message);
      }

      expect(started.value.structured).toEqual({ summary: "All good", risk: "low" });
      expect(started.value.state.structured).toEqual({ summary: "All good", risk: "low" });
      expect(started.value.state.status).toBe("completed");
    } finally {
      sdk.dispose();
      vi.useRealTimers();
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);
