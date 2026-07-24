import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import openWikiExtension, {
  __openWikiExtensionInternalsForTests as internals,
} from "../src/extensions/openwiki/index.js";
import { MODE_ACTIVATE_EVENT } from "../src/extensions/modes/index.js";
import { isRecord } from "../src/utils/unknown-data.js";
import { createPlaybookStreamFn, says, when } from "./support/pi-test-harness/playbook.js";
import { createTestSession } from "./support/pi-test-harness/session.js";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

function resolveModeActivation(data: unknown): void {
  if (!isRecord(data) || !isRecord(data.done)) {
    return;
  }

  const resolve = data.done.resolve;
  if (typeof resolve === "function") {
    resolve();
  }
}

function createModeChangedEvent(data: unknown): { cwd: string; mode: string } | undefined {
  if (!isRecord(data) || typeof data.mode !== "string" || !isRecord(data.ctx)) {
    return undefined;
  }

  const cwd = data.ctx.cwd;
  return typeof cwd === "string" ? { cwd, mode: data.mode } : undefined;
}

function createContext(cwd: string): ExtensionContext {
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
  } as unknown as ExtensionContext;
}

function createOpenWikiHarness(cwd: string) {
  const handlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const sentUserMessages: string[] = [];
  const registerCommand = vi.fn();

  const pi = {
    events: {
      emit: (eventName: string, data: unknown) => {
        if (eventName === MODE_ACTIVATE_EVENT) {
          const modeChangedEvent = createModeChangedEvent(data);
          if (modeChangedEvent !== undefined) {
            for (const handler of eventHandlers.get("modes:changed") ?? []) {
              handler(modeChangedEvent);
            }
          }
          resolveModeActivation(data);
        }
      },
      on(eventName: string, handler: (data: unknown) => void) {
        eventHandlers.set(eventName, [...(eventHandlers.get(eventName) ?? []), handler]);
      },
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
    registerCommand,
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
  } as unknown as ExtensionAPI;

  openWikiExtension(pi);

  const ctx = createContext(cwd);

  return {
    ctx,
    pi,
    registerCommand,
    sentMessages,
    sentUserMessages,
    emitModeChanged(mode: string | undefined) {
      for (const handler of eventHandlers.get("modes:changed") ?? []) {
        handler({ cwd, mode });
      }
    },
    async emit(eventName: string, event: Record<string, unknown> = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(eventName) ?? []) {
        results.push(await handler(event, ctx));
      }
      return results;
    },
    async runInput(text: string) {
      const [result] = await this.emit("input", {
        text,
        source: "interactive",
        streamingBehavior: undefined,
      });
      return result;
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
    expect(internals.parseOpenWikiInputText("/openwiki init focus API docs")).toBe(
      "init focus API docs",
    );
    expect(internals.parseOpenWikiInputText("/openwikiinit")).toBeNull();
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

    const inputResult = await harness.runInput("/openwiki init focus API docs");
    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

    expect(harness.registerCommand).not.toHaveBeenCalled();
    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.sentMessages).toHaveLength(0);
    expect(inputResult).toEqual({
      action: "transform",
      text: internals.formatOpenWikiPrompt("init"),
    });
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

  test("skips command details when current mode is not openwiki", async () => {
    const harness = createOpenWikiHarness(await createTempCwd());

    await harness.runInput("/openwiki init focus API docs");
    harness.emitModeChanged("build");
    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

    expect(result).toBeUndefined();
  });

  test("session prompt path injects command details before model call", async () => {
    const modeResponder = (pi: ExtensionAPI) => {
      pi.events.on(MODE_ACTIVATE_EVENT, (data) => {
        const modeChangedEvent = createModeChangedEvent(data);
        if (modeChangedEvent !== undefined) {
          pi.events.emit("modes:changed", modeChangedEvent);
        }
        resolveModeActivation(data);
      });
    };
    const session = await createTestSession({
      extensionFactories: [modeResponder, openWikiExtension],
    });
    if (session.session.model !== undefined) {
      await session.session.modelRuntime.setRuntimeApiKey(
        session.session.model.provider,
        "test-key",
      );
    }
    let capturedSystemPrompt = "";
    const playbook = createPlaybookStreamFn([
      when(internals.formatOpenWikiPrompt("init"), [says("ok")]),
    ]);

    try {
      (session.session.agent as { streamFunction: typeof playbook.streamFn }).streamFunction = (
        model,
        context,
        options,
      ) => {
        capturedSystemPrompt = context.systemPrompt;
        return playbook.streamFn(model, context, options);
      };

      await session.session.prompt("/openwiki init");
      await session.session.agent.waitForIdle();

      expect(capturedSystemPrompt).toContain("OpenWiki command prompt:");
      expect(capturedSystemPrompt).toContain("Initialize OpenWiki documentation");
    } finally {
      session.dispose();
    }
  });

  test("clears pending command state on session start", async () => {
    const harness = createOpenWikiHarness(await createTempCwd());

    await harness.runInput("/openwiki init focus API docs");
    await harness.emit("session_start");
    const [result] = await harness.emit("before_agent_start", { systemPrompt: "base prompt" });

    expect(result).toBeUndefined();
  });
});
