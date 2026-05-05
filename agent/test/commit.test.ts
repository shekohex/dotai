import { expect, test, vi } from "vitest";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Value } from "typebox/value";

import { createCommitExtension } from "../src/extensions/commit.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: any) => Promise<void>;
};

class FakePi implements Partial<ExtensionAPI> {
  readonly commands = new Map<string, RegisteredCommand>();
  readonly sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  readonly handlers = new Map<string, Array<(...args: any[]) => any>>();
  gitAvailable = true;

  registerCommand(name: string, command: RegisteredCommand): void {
    this.commands.set(name, command);
  }

  sendMessage(message: unknown, options?: unknown): void {
    this.sentMessages.push({ message, options });
  }

  on(eventName: string, handler: (...args: any[]) => any): void {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }

  async exec(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    if (command === "git") {
      return this.gitAvailable
        ? { code: 0, stdout: ".git\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "fatal: not a git repository" };
    }

    return { code: 0, stdout: "", stderr: "" };
  }
}

function createCommandContext(notifications: Array<{ message: string; level: string }>) {
  return {
    cwd: process.cwd(),
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };
}

function createValidStructuredSummary() {
  return {
    summaryMarkdown: "- abc1234 feat(core): wire command",
    commits: [{ sha: "abc1234", message: "feat(core): wire command", files: ["src/a.ts"] }],
    warnings: [],
    remainingChanges: [],
  };
}

function createHandleThatCompletes(structured = createValidStructuredSummary()) {
  return {
    sessionId: "session-id",
    waitForCompletion: async () => ({
      status: "completed",
      structured,
    }),
  };
}

timedTest("commit command starts commiter mode with structured output", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const startCalls: Array<{ params: any; ctx: any }> = [];

  createCommitExtension({
    sdkFactory: () => ({
      async start(params, ctx) {
        startCalls.push({ params, ctx });
        return {
          handle: createHandleThatCompletes(),
          prompt: "prompt",
          state: {} as any,
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  expect(command).toBeTruthy();

  await command.handler("include docs too", createCommandContext(notifications));

  expect(startCalls.length).toBe(1);
  expect(startCalls[0]?.params.mode).toBe("commiter");
  expect(startCalls[0]?.params.persisted).toBe(false);
  expect(startCalls[0]?.params.completion).toBe(false);
  expect(startCalls[0]?.params.outputFormat?.type).toBe("json_schema");
  expect(startCalls[0]?.params.task ?? "").toMatch(/Additional user details:\ninclude docs too/);

  await vi.waitFor(() => {
    expect(fakePi.sentMessages.length).toBe(1);
  });
  expect(
    (fakePi.sentMessages[0]?.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
  ).toBe(false);
  expect((fakePi.sentMessages[0]?.message as { customType?: string } | undefined)?.customType).toBe(
    "commit-summary",
  );
});

timedTest("commit command stops when cwd is not a git repository", async () => {
  const fakePi = new FakePi();
  fakePi.gitAvailable = false;
  const notifications: Array<{ message: string; level: string }> = [];
  let startCalled = false;

  createCommitExtension({
    sdkFactory: () => ({
      async start() {
        startCalled = true;
        throw new Error("unexpected start");
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  expect(command).toBeTruthy();

  await command.handler("", createCommandContext(notifications));

  expect(startCalled).toBe(false);
  expect(notifications.at(-1)).toEqual({ message: "Not a git repository", level: "error" });
});

timedTest("commit command prevents concurrent runs while child still active", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  let resolveCompletion: (() => void) | undefined;
  let startCalls = 0;

  createCommitExtension({
    sdkFactory: () => ({
      async start() {
        startCalls += 1;
        return {
          handle: {
            sessionId: "session-id",
            waitForCompletion: async () => {
              await new Promise<void>((resolve) => {
                resolveCompletion = resolve;
              });
              return {
                status: "completed",
                structured: createValidStructuredSummary(),
              };
            },
          },
          prompt: "prompt",
          state: {} as any,
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  expect(command).toBeTruthy();

  await expect(command.handler("", createCommandContext(notifications))).resolves.toBeUndefined();
  while (!resolveCompletion) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await command.handler("", createCommandContext(notifications));

  expect(startCalls).toBe(1);
  expect(
    notifications.some(
      (entry) => entry.message === "A commit job is already running." && entry.level === "warning",
    ),
  ).toBe(true);

  resolveCompletion?.();
  await vi.waitFor(() => {
    expect(fakePi.sentMessages.length).toBe(1);
  });
});

timedTest("commit schema validates rich constraints and required fields", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  let capturedSchema: any;

  createCommitExtension({
    sdkFactory: () => ({
      async start(params) {
        capturedSchema =
          params.outputFormat?.type === "json_schema" ? params.outputFormat.schema : undefined;
        return {
          handle: createHandleThatCompletes(),
          prompt: "prompt",
          state: {} as any,
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  expect(command).toBeTruthy();

  await command.handler("", createCommandContext(notifications));

  expect(capturedSchema).toBeTruthy();

  const valid = createValidStructuredSummary();
  expect(Value.Check(capturedSchema, valid)).toBe(true);

  const invalidShaUpper = {
    ...valid,
    commits: [{ ...valid.commits[0], sha: "ABC1234" }],
  };
  expect(Value.Check(capturedSchema, invalidShaUpper)).toBe(false);

  const invalidShaShort = {
    ...valid,
    commits: [{ ...valid.commits[0], sha: "abc" }],
  };
  expect(Value.Check(capturedSchema, invalidShaShort)).toBe(false);

  const { remainingChanges, ...missingRequired } = valid;
  void remainingChanges;
  expect(Value.Check(capturedSchema, missingRequired)).toBe(false);

  const withUnexpectedField = {
    ...valid,
    unknown: true,
  };
  expect(Value.Check(capturedSchema, withUnexpectedField)).toBe(false);
});

timedTest("commit command renders warning and remaining-change sections", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];

  createCommitExtension({
    sdkFactory: () => ({
      async start() {
        return {
          handle: createHandleThatCompletes({
            ...createValidStructuredSummary(),
            warnings: ["Pre-commit hook skipped markdown formatting"],
            remainingChanges: ["README.md"],
          }),
          prompt: "prompt",
          state: {} as any,
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  expect(command).toBeTruthy();

  await command.handler("", createCommandContext(notifications));
  await vi.waitFor(() => {
    expect(fakePi.sentMessages.length).toBe(1);
  });

  const sentMessage = fakePi.sentMessages[0]?.message as { content?: string } | undefined;
  expect(sentMessage?.content).toBeTruthy();
  expect(sentMessage.content).toMatch(/## Warnings/);
  expect(sentMessage.content).toMatch(/Pre-commit hook skipped markdown formatting/);
  expect(sentMessage.content).toMatch(/## Remaining Changes/);
  expect(sentMessage.content).toMatch(/README\.md/);
});

timedTest("commit command surfaces terminal summary failures", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];

  createCommitExtension({
    sdkFactory: () => ({
      async start() {
        return {
          handle: {
            sessionId: "session-id",
            waitForCompletion: async () => ({
              status: "failed",
              summary: "Structured output validation failed and retry budget was exhausted.",
            }),
          },
          prompt: "prompt",
          state: {} as any,
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  expect(command).toBeTruthy();

  await command.handler("", createCommandContext(notifications));
  await vi.waitFor(() => {
    expect(
      notifications.some(
        (entry) =>
          entry.level === "error" &&
          entry.message ===
            "Commit failed: Structured output validation failed and retry budget was exhausted.",
      ),
    ).toBe(true);
  });
  expect(fakePi.sentMessages.length).toBe(0);
});

timedTest("commit command catches thrown background errors", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];

  createCommitExtension({
    sdkFactory: () => ({
      async start() {
        return {
          handle: {
            sessionId: "session-id",
            waitForCompletion: async () => {
              throw new Error("tmux unavailable");
            },
          },
          prompt: "prompt",
          state: {} as any,
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  expect(command).toBeTruthy();

  await expect(command.handler("", createCommandContext(notifications))).resolves.toBeUndefined();
  await vi.waitFor(() => {
    expect(notifications.some((entry) => entry.message === "Commit failed: tmux unavailable")).toBe(
      true,
    );
  });
});

timedTest("commit command catches start failures", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];

  createCommitExtension({
    sdkFactory: () => ({
      async start() {
        throw new Error("launch failed");
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  expect(command).toBeTruthy();

  await command.handler("", createCommandContext(notifications));

  expect(notifications.at(-1)).toEqual({ message: "Commit failed: launch failed", level: "error" });
});
