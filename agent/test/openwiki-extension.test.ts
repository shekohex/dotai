import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import openWikiExtension, {
  __openWikiExtensionInternalsForTests as internals,
} from "../src/extensions/openwiki/index.js";
import { isRecord } from "../src/utils/unknown-data.js";

type Handler = (event: { systemPrompt?: string }, ctx: ExtensionContext) => unknown;
type OpenWikiCommandHandler = (args: string, ctx: ExtensionCommandContext) => unknown;

function resolveModeActivation(data: unknown): void {
  if (!isRecord(data) || !isRecord(data.done)) {
    return;
  }

  const resolve = data.done.resolve;
  if (typeof resolve === "function") {
    resolve();
  }
}

function createContext(cwd: string): ExtensionCommandContext {
  return {
    cwd,
    model: { provider: "test-provider", id: "test-model" },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
    },
    ui: {
      notify: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
}

function createOpenWikiHarness(cwd: string) {
  const handlers = new Map<string, Handler[]>();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  let commandHandler: OpenWikiCommandHandler | undefined;

  const pi = {
    events: {
      emit: (_eventName: string, data: unknown) => resolveModeActivation(data),
    },
    exec: vi.fn(async (_command: string, args: string[]) => ({
      stdout: args.includes("rev-parse") ? `${"a".repeat(40)}\n` : "",
      stderr: "",
      code: 0,
      killed: false,
    })),
    on(eventName: string, handler: Handler) {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
    registerCommand(name: string, definition: { handler: OpenWikiCommandHandler }) {
      if (name === "openwiki") {
        commandHandler = definition.handler;
      }
    },
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  openWikiExtension(pi);

  const ctx = createContext(cwd);

  return {
    ctx,
    pi,
    sentMessages,
    async emit(eventName: string, event: { systemPrompt?: string } = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(eventName) ?? []) {
        results.push(await handler(event, ctx));
      }
      return results;
    },
    async runCommand(args: string) {
      if (commandHandler === undefined) {
        throw new Error("openwiki command not registered");
      }
      await commandHandler(args, ctx);
    },
  };
}

async function createTempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-openwiki-extension-"));
}

describe("openwiki extension", () => {
  test("parses slash command subcommands", () => {
    expect(internals.parseOpenWikiCommand("")).toEqual({ kind: "switch" });
    expect(internals.parseOpenWikiCommand("help")).toEqual({ kind: "help" });
    expect(internals.parseOpenWikiCommand("init focus API docs")).toEqual({
      kind: "run",
      command: "init",
      additionalInstruction: "focus API docs",
    });
    expect(internals.parseOpenWikiCommand("what changed?")).toEqual({
      kind: "run",
      command: "chat",
      additionalInstruction: "what changed?",
    });
  });

  test("validates git heads before metadata uses them", async () => {
    const cwd = await createTempCwd();
    const validPi = {
      exec: async () => ({ stdout: `${"a".repeat(40)}\n`, stderr: "", code: 0, killed: false }),
    } as unknown as ExtensionAPI;
    const invalidPi = {
      exec: async () => ({
        stdout: "fatal: not a git repository",
        stderr: "",
        code: 128,
        killed: false,
      }),
    } as unknown as ExtensionAPI;

    expect(internals.isGitCommitSha("a".repeat(40))).toBe(true);
    expect(internals.isGitCommitSha("fatal: not a git repository")).toBe(false);
    await expect(internals.getGitHead(validPi, cwd)).resolves.toBe("a".repeat(40));
    await expect(internals.getGitHead(invalidPi, cwd)).resolves.toBeUndefined();
  });

  test("injects openwiki command details into system prompt", async () => {
    const harness = createOpenWikiHarness(await createTempCwd());

    await harness.runCommand("init focus API docs");
    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

    expect(harness.sentMessages).toHaveLength(1);
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("OpenWiki command prompt:"),
    });
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Initialize OpenWiki documentation"),
    });
    expect(result).toMatchObject({
      systemPrompt: expect.stringContaining("Additional instruction:\nfocus API docs"),
    });
  });

  test("clears pending command state on session start", async () => {
    const harness = createOpenWikiHarness(await createTempCwd());

    await harness.runCommand("init focus API docs");
    await harness.emit("session_start");
    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

    expect(result).toBeUndefined();
  });
});
