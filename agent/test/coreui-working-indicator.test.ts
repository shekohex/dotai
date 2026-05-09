import { expect, test } from "vitest";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { theme as activeTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import coreUIExtension from "../src/extensions/coreui.ts";

const TEST_TIMEOUT_MS = 15_000;

const timedTest: typeof test = ((name: string, fn: (...args: unknown[]) => unknown) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => void;

timedTest("coreui applies custom pastel working indicator", () => {
  initTheme("dark");

  const sessionStartHandlers: SessionStartHandler[] = [];
  let indicator: WorkingIndicatorOptions | undefined;

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

  const fakeContext = {
    cwd: process.cwd(),
    ui: {
      theme: activeTheme,
      setEditorComponent: () => {},
      setHeader: () => {},
      setFooter: () => {},
      setWorkingIndicator: (options?: WorkingIndicatorOptions) => {
        indicator = options;
      },
    },
    isIdle: () => true,
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

  coreUIExtension(fakePi);

  for (const handler of sessionStartHandlers) {
    handler({}, fakeContext);
  }

  expect(indicator?.intervalMs).toBe(80);
  expect(indicator?.frames?.length).toBe(8);
  expect(indicator?.frames?.[0]).toContain("⣾");
  expect(indicator?.frames?.[0]).toContain("\u001B[38;2;255;179;186m");
  expect(indicator?.frames?.[0]).toContain("\u001B[39m");
  expect(indicator?.frames?.[5]).toContain("\u001B[38;2;218;186;255m");
});
