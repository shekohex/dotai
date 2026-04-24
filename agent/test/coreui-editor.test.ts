import test from "node:test";
import assert from "node:assert/strict";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/keybindings.js";
import { theme as activeTheme } from "../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import coreUIExtension from "../src/extensions/coreui.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => void;

timedTest("coreui editor placeholder timer ignores stale replacement context", () => {
  initTheme("dark");

  const sessionStartHandlers: SessionStartHandler[] = [];
  let editorFactory:
    | ((
        tui: { requestRender: () => void },
        theme: typeof activeTheme,
        keybindings: KeybindingsManager,
      ) => { dispose?: () => void })
    | undefined;
  let intervalCallback: (() => void) | undefined;

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = ((handler: TimerHandler) => {
    intervalCallback = typeof handler === "function" ? handler : undefined;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;

  try {
    const fakePi = {
      on: (eventName: string, handler: SessionStartHandler) => {
        if (eventName === "session_start") {
          sessionStartHandlers.push(handler);
        }
      },
      events: {
        on: () => () => {},
      },
      getActiveTools: () => [],
      registerTool: () => {},
      registerCommand: () => {},
      getThinkingLevel: () => "medium",
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0, cancelled: false }),
    } as unknown as ExtensionAPI;

    coreUIExtension(fakePi);
    assert.ok(sessionStartHandlers.length > 0);

    const fakeContext = {
      cwd: process.cwd(),
      ui: {
        theme: activeTheme,
        setEditorComponent: (factory: typeof editorFactory) => {
          editorFactory = factory;
        },
        setHeader: () => {},
        setFooter: () => {},
      },
      isIdle: () => {
        throw new Error(
          "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
        );
      },
      sessionManager: {
        getEntries: () => [],
        getCwd: () => process.cwd(),
        getBranch: () => [],
      },
      hasUI: true,
      model: undefined,
      signal: undefined,
      getContextUsage: () => undefined,
    } as unknown as ExtensionContext;

    for (const handler of sessionStartHandlers) {
      handler({}, fakeContext);
    }
    assert.ok(editorFactory);

    const editor = editorFactory!(
      { requestRender: () => {} },
      activeTheme,
      KeybindingsManager.create(),
    );

    assert.doesNotThrow(() => {
      intervalCallback?.();
    });

    editor.dispose?.();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
