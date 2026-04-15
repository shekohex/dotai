import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";

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

timedTest("commit command spawns commiter mode with structured output", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const spawnCalls: Array<{ params: any; ctx: any }> = [];

  createCommitExtension({
    sdkFactory: () => ({
      async spawn(params, ctx) {
        spawnCalls.push({ params, ctx });
        return {
          ok: true as const,
          value: {
            handle: { sessionId: "session-id" },
            prompt: "prompt",
            state: {} as any,
            structured: createValidStructuredSummary(),
          },
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  assert.ok(command);

  await command.handler("include docs too", createCommandContext(notifications));

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.params.mode, "commiter");
  assert.equal(spawnCalls[0]?.params.outputFormat?.type, "json_schema");
  assert.match(spawnCalls[0]?.params.task ?? "", /Additional user details:\ninclude docs too/);
  assert.equal(fakePi.sentMessages.length, 1);
  assert.equal(
    (fakePi.sentMessages[0]?.options as { triggerTurn?: boolean } | undefined)?.triggerTurn,
    false,
  );
  assert.equal(
    (fakePi.sentMessages[0]?.message as { customType?: string } | undefined)?.customType,
    "commit-summary",
  );
});

timedTest("commit command stops when cwd is not a git repository", async () => {
  const fakePi = new FakePi();
  fakePi.gitAvailable = false;
  const notifications: Array<{ message: string; level: string }> = [];
  let spawnCalled = false;

  createCommitExtension({
    sdkFactory: () => ({
      async spawn() {
        spawnCalled = true;
        throw new Error("unexpected spawn");
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  assert.ok(command);

  await command.handler("", createCommandContext(notifications));

  assert.equal(spawnCalled, false);
  assert.deepEqual(notifications.at(-1), { message: "Not a git repository", level: "error" });
});

timedTest("commit command prevents concurrent runs", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  let resolveSpawn: (() => void) | undefined;
  let spawnCalls = 0;

  createCommitExtension({
    sdkFactory: () => ({
      async spawn() {
        spawnCalls += 1;
        await new Promise<void>((resolve) => {
          resolveSpawn = resolve;
        });
        return {
          ok: true as const,
          value: {
            handle: { sessionId: "session-id" },
            prompt: "prompt",
            state: {} as any,
            structured: createValidStructuredSummary(),
          },
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  assert.ok(command);

  const first = command.handler("", createCommandContext(notifications));
  while (!resolveSpawn) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const second = command.handler("", createCommandContext(notifications));
  await second;

  assert.equal(spawnCalls, 1);
  assert.ok(
    notifications.some(
      (entry) => entry.message === "A commit job is already running." && entry.level === "warning",
    ),
  );

  resolveSpawn?.();
  await first;
});

timedTest("commit schema validates rich constraints and required fields", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  let capturedSchema: any;

  createCommitExtension({
    sdkFactory: () => ({
      async spawn(params) {
        capturedSchema =
          params.outputFormat?.type === "json_schema" ? params.outputFormat.schema : undefined;
        return {
          ok: true as const,
          value: {
            handle: { sessionId: "session-id" },
            prompt: "prompt",
            state: {} as any,
            structured: createValidStructuredSummary(),
          },
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  assert.ok(command);

  await command.handler("", createCommandContext(notifications));

  assert.ok(capturedSchema);

  const valid = createValidStructuredSummary();
  assert.equal(Value.Check(capturedSchema, valid), true);

  const invalidShaUpper = {
    ...valid,
    commits: [{ ...valid.commits[0], sha: "ABC1234" }],
  };
  assert.equal(Value.Check(capturedSchema, invalidShaUpper), false);

  const invalidShaShort = {
    ...valid,
    commits: [{ ...valid.commits[0], sha: "abc" }],
  };
  assert.equal(Value.Check(capturedSchema, invalidShaShort), false);

  const { remainingChanges, ...missingRequired } = valid;
  void remainingChanges;
  assert.equal(Value.Check(capturedSchema, missingRequired), false);

  const withUnexpectedField = {
    ...valid,
    unknown: true,
  };
  assert.equal(Value.Check(capturedSchema, withUnexpectedField), false);
});

timedTest("commit command renders warning and remaining-change sections", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];

  createCommitExtension({
    sdkFactory: () => ({
      async spawn() {
        return {
          ok: true as const,
          value: {
            handle: { sessionId: "session-id" },
            prompt: "prompt",
            state: {} as any,
            structured: {
              ...createValidStructuredSummary(),
              warnings: ["Pre-commit hook skipped markdown formatting"],
              remainingChanges: ["README.md"],
            },
          },
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  assert.ok(command);

  await command.handler("", createCommandContext(notifications));

  const sentMessage = fakePi.sentMessages[0]?.message as { content?: string } | undefined;
  assert.ok(sentMessage?.content);
  assert.match(sentMessage.content, /## Warnings/);
  assert.match(sentMessage.content, /Pre-commit hook skipped markdown formatting/);
  assert.match(sentMessage.content, /## Remaining Changes/);
  assert.match(sentMessage.content, /README\.md/);
});

timedTest("commit command surfaces structured spawn errors", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];

  createCommitExtension({
    sdkFactory: () => ({
      async spawn() {
        return {
          ok: false as const,
          error: {
            code: "validation_failed",
            message: "Structured output validation failed and retry budget was exhausted.",
          },
        };
      },
      dispose() {},
    }),
  })(fakePi as ExtensionAPI);

  const command = fakePi.commands.get("commit");
  assert.ok(command);

  await command.handler("", createCommandContext(notifications));

  assert.ok(
    notifications.some(
      (entry) =>
        entry.level === "error" &&
        entry.message ===
          "Commit failed (validation_failed): Structured output validation failed and retry budget was exhausted.",
    ),
  );
  assert.equal(fakePi.sentMessages.length, 0);
});
