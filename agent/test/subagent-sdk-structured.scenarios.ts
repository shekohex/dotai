import { expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

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
      vi.useFakeTimers();

      await vi.advanceTimersByTimeAsync(2_500);
      const started = await spawnPromise;
      expect(started.ok).toBe(false);
      if (started.ok) {
        throw new Error("Expected structured spawn to fail");
      }

      expect(started.error.code).toBe("validation_failed");
      expect(started.error.retryCount).toBe(2);
      expect(started.error.attempts).toBe(2);
    } finally {
      sdk.dispose();
      vi.useRealTimers();
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(agentDir, { recursive: true, force: true });
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);
