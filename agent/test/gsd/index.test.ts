import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gsdExtension from "../../src/extensions/gsd/index.ts";
import {
  listGsdSubagents,
  setGsdSubagentSdkFactoryForTests,
} from "../../src/extensions/gsd/subagents.ts";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: any) => Promise<void>;
};

class FakePi implements Partial<ExtensionAPI> {
  readonly commands = new Map<string, RegisteredCommand>();
  readonly handlers = new Map<string, Array<(...args: any[]) => any>>();
  readonly messageRenderers = new Map<string, unknown>();
  readonly flags = new Map<string, { description?: string; type: "boolean" | "string" }>();

  registerFlag(
    name: string,
    definition: { description?: string; type: "boolean" | "string" },
  ): void {
    this.flags.set(name, definition);
  }

  getFlag(): boolean | string | undefined {
    return undefined;
  }

  registerCommand(name: string, command: RegisteredCommand): void {
    this.commands.set(name, command);
  }

  on(eventName: string, handler: (...args: any[]) => any): void {
    const handlers = this.handlers.get(eventName) ?? [];
    handlers.push(handler);
    this.handlers.set(eventName, handlers);
  }

  registerMessageRenderer(customType: string, renderer: unknown): void {
    this.messageRenderers.set(customType, renderer);
  }
}

async function copyFixture(name: string): Promise<string> {
  const root = createTempDirSync("agent-gsd-index-");
  await mkdir(join(root), { recursive: true });
  await cp(join(import.meta.dirname, "fixtures", name, ".planning"), join(root, ".planning"), {
    recursive: true,
  });
  return root;
}

function createCommandContext(
  cwd: string,
  notifications: Array<{ message: string; level: string }>,
  sessionId = "parent-session-id",
) {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
}

async function emitHandlersWithResult(
  fakePi: FakePi,
  eventName: string,
  event: Record<string, unknown>,
  ctx: ReturnType<typeof createCommandContext>,
) {
  const handlers = fakePi.handlers.get(eventName) ?? [];
  const results = [];
  for (const handler of handlers) {
    results.push(await handler(event, ctx));
  }
  return results;
}

test("session_start continues valid brownfield project in place", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = await copyFixture("brownfield-v1");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const handlers = fakePi.handlers.get("session_start") ?? [];
  for (const handler of handlers) {
    await handler({}, createCommandContext(cwd, notifications));
  }
  const state = await readFile(join(cwd, ".planning", "STATE.md"), "utf8");
  expect(state).toContain("current_phase: 1");
  expect(state).toContain("current_plan: 01-02");
  expect(notifications).toContainEqual({
    message: "GSD continuing Brownfield Demo (2 phases)",
    level: "info",
  });
});

test("before_agent_start appends brownfield planning context when enabled", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = await copyFixture("brownfield-v1");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const results = await emitHandlersWithResult(
    fakePi,
    "before_agent_start",
    { systemPrompt: "Base prompt", prompt: "Task" },
    createCommandContext(cwd, notifications),
  );
  expect(results).toContainEqual({
    systemPrompt: expect.stringContaining("Base prompt\n\nGSD Planning Context"),
  });
  const combined = results.find(
    (result): result is { systemPrompt: string } =>
      typeof result === "object" &&
      result !== null &&
      "systemPrompt" in result &&
      typeof result.systemPrompt === "string",
  );
  expect(combined?.systemPrompt).toContain("Project: Brownfield Demo");
  expect(combined?.systemPrompt).toContain("Phase: 1 Setup");
  expect(combined?.systemPrompt).toContain("Plan: 01-02");
});

test("before_agent_start leaves prompt untouched when planning tree missing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempDirSync("agent-gsd-index-empty-");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const results = await emitHandlersWithResult(
    fakePi,
    "before_agent_start",
    { systemPrompt: "Base prompt", prompt: "Task" },
    createCommandContext(cwd, notifications),
  );
  expect(results.every((result) => result === undefined)).toBe(true);
});

test("registers both codebase-map and intel-refresh message renderers", () => {
  const fakePi = new FakePi();
  gsdExtension(fakePi as ExtensionAPI);

  expect(fakePi.messageRenderers.has("gsd-help")).toBe(true);
  expect(fakePi.messageRenderers.has("gsd-codebase-map-summary")).toBe(true);
  expect(fakePi.messageRenderers.has("gsd-intel-refresh-summary")).toBe(true);
});

test("session_shutdown disposes only matching session-scoped GSD SDK", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const disposeFirst = vi.fn();
  const disposeSecond = vi.fn();
  const sdkFactory = vi
    .fn()
    .mockReturnValueOnce({ list: () => [{ name: "gsd-first" }], dispose: disposeFirst })
    .mockReturnValueOnce({ list: () => [{ name: "gsd-second" }], dispose: disposeSecond });

  setGsdSubagentSdkFactoryForTests(sdkFactory as never);
  gsdExtension(fakePi as ExtensionAPI);

  const firstContext = createCommandContext(
    createTempDirSync("agent-gsd-index-first-"),
    notifications,
    "first",
  );
  const secondContext = createCommandContext(
    createTempDirSync("agent-gsd-index-second-"),
    notifications,
    "second",
  );

  expect(listGsdSubagents(fakePi as ExtensionAPI, firstContext as never)).toHaveLength(1);
  expect(listGsdSubagents(fakePi as ExtensionAPI, secondContext as never)).toHaveLength(1);

  await emitHandlersWithResult(fakePi, "session_shutdown", {}, firstContext);

  expect(disposeFirst).toHaveBeenCalledTimes(1);
  expect(disposeSecond).toHaveBeenCalledTimes(0);
  expect(listGsdSubagents(fakePi as ExtensionAPI, secondContext as never)).toHaveLength(1);
  expect(sdkFactory).toHaveBeenCalledTimes(2);

  setGsdSubagentSdkFactoryForTests(undefined);
  expect(disposeSecond).toHaveBeenCalledTimes(1);
});
