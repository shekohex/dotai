import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("submit_plan tool", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    vi.resetModules();
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  afterEach(() => {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  function createContext(cwd: string): ExtensionContext {
    return {
      cwd,
      hasUI: true,
      ui: {
        setWidget() {},
        notify() {},
        onTerminalInput(handler: (data: string) => unknown) {
          return handler;
        },
      },
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
      },
      shutdown() {},
    } as unknown as ExtensionContext;
  }

  it("registers self-rendered tool and emits queued update before denial", async () => {
    const startPlanReviewBrowserSession = vi.fn(async () => ({
      url: "https://example.com/plan-review/123",
      waitForDecision: async () => ({ approved: false, feedback: "Need more detail." }),
    }));

    vi.doMock("../src/extensions/plannotator/plannotator-command-deps.js", async () => {
      const actual = await vi.importActual<object>(
        "../src/extensions/plannotator/plannotator-command-deps.js",
      );
      return {
        ...actual,
        hasPlanBrowserHtml: () => true,
        startPlanReviewBrowserSession,
      };
    });

    const cwd = await mkdtemp(join(tmpdir(), "pi-submit-plan-"));
    await writeFile(join(cwd, "PLAN.md"), "# Plan", "utf8");
    try {
      const module = await import("../src/extensions/plannotator/plannotator-command-handlers.js");
      let toolDefinition: Record<string, unknown> | undefined;
      const pi = {
        registerTool(definition: Record<string, unknown>) {
          toolDefinition = definition;
        },
        appendEntry() {},
      };
      const persistState = vi.fn();

      module.registerPlanSubmitTool({
        pi: pi as never,
        getPhase: () => "planning",
        setPhase() {},
        getLastSubmittedPath: () => "PLAN.md",
        setLastSubmittedPath() {},
        persistState,
        applyPhaseConfig: async () => {},
        setJustApprovedPlan() {},
      });

      expect(toolDefinition).toBeTruthy();
      expect(toolDefinition?.renderShell).toBe("self");

      const updates: unknown[] = [];
      const ctx = createContext(cwd);
      const result = await (
        toolDefinition?.execute as (
          toolCallId: string,
          params: { filePath: string },
          signal: AbortSignal,
          onUpdate: (value: unknown) => void,
          ctx: ExtensionContext,
        ) => Promise<{ details: Record<string, unknown> }>
      )(
        "tool-1",
        { filePath: "PLAN.md" },
        new AbortController().signal,
        (value) => {
          updates.push(value);
        },
        ctx,
      );

      expect(startPlanReviewBrowserSession).toHaveBeenCalledWith(ctx, "# Plan");
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        details: {
          status: "queued",
          approved: false,
          url: "https://example.com/plan-review/123",
          filePath: "PLAN.md",
        },
      });
      expect(result.details).toMatchObject({
        status: "denied",
        approved: false,
        feedback: "Need more detail.",
        filePath: "PLAN.md",
      });
      expect(persistState).toHaveBeenCalledTimes(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("plannotator extension does not register submit_plan by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-submit-plan-settings-"));
    process.env.PI_CODING_AGENT_DIR = cwd;
    try {
      const { default: plannotator } = await import("../src/extensions/plannotator/index.js");
      const registeredTools: string[] = [];
      const pi = createPlannotatorPi(registeredTools);

      plannotator(pi as never);

      expect(registeredTools).not.toContain("submit_plan");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("plannotator extension registers submit_plan when setting enables it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-submit-plan-settings-"));
    process.env.PI_CODING_AGENT_DIR = cwd;
    await writeFile(
      join(cwd, "settings.json"),
      JSON.stringify({ plannotator: { submitPlanTool: { enabled: true } } }),
      "utf8",
    );

    try {
      const { default: plannotator } = await import("../src/extensions/plannotator/index.js");
      const registeredTools: string[] = [];
      const pi = createPlannotatorPi(registeredTools);

      plannotator(pi as never);

      expect(registeredTools).toContain("submit_plan");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function createPlannotatorPi(registeredTools: string[]) {
  return {
    appendEntry() {},
    events: {
      emit() {},
      on() {
        return () => {};
      },
    },
    getActiveTools: () => [],
    getFlag: () => false,
    getThinkingLevel: () => "low",
    on() {},
    registerCommand() {},
    registerFlag() {},
    registerMessageRenderer() {},
    registerTool(definition: { name: string }) {
      registeredTools.push(definition.name);
    },
    sendMessage() {},
    setActiveTools() {},
    setThinkingLevel() {},
  };
}
