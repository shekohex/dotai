import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gsdExtension from "../../src/extensions/gsd/index.ts";
import { parseGsdCommandArgs } from "../../src/extensions/gsd/args.ts";
import { setProgressExecFileSyncForTests } from "../../src/extensions/gsd/lifecycle/progress.ts";
import { resolveInstructionFileName } from "../../src/extensions/gsd/lifecycle/new-project.ts";
import { readRoadmapPhases } from "../../src/extensions/gsd/state/roadmap.ts";
import { setGsdSubagentSdkFactoryForTests } from "../../src/extensions/gsd/subagents.ts";
import { resolveGsdBundlePath } from "../../src/extensions/gsd/resources.ts";
import { createTempDirSync } from "../test-utils/temp-paths.ts";

type RegisteredCommand = {
  description: string;
  getArgumentCompletions?: (prefix: string) => Promise<any[] | null> | any[] | null;
  handler: (args: string, ctx: any) => Promise<void>;
};

class FakePi implements Partial<ExtensionAPI> {
  readonly commands = new Map<string, RegisteredCommand>();
  readonly handlers = new Map<string, Array<(...args: any[]) => any>>();
  readonly messageRenderers = new Map<string, unknown>();
  private activeTools: string[] = [];
  readonly sendMessage = vi.fn();
  readonly sendUserMessage = vi.fn();

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

  getActiveTools(): string[] {
    return this.activeTools;
  }

  setActiveTools(tools: string[]): void {
    this.activeTools = tools;
  }
}

afterEach(() => {
  setGsdSubagentSdkFactoryForTests(undefined);
  setProgressExecFileSyncForTests(undefined);
});

async function emitFakeSessionStart(
  fakePi: FakePi,
  reason: "new" | "fork",
  cwd: string,
): Promise<void> {
  const handlers = fakePi.handlers.get("session_start") ?? [];
  const replacementCtx = {
    cwd,
    hasUI: false,
    ui: { notify() {} },
    modelRegistry: {
      find(provider: string, id: string) {
        return { provider, id };
      },
    },
  };

  for (const handler of handlers) {
    await handler({ reason }, replacementCtx);
  }
}

function createCommandContext(
  cwd: string,
  notifications: Array<{ message: string; level: string }>,
  fakePi?: FakePi,
) {
  const modelRegistry = {
    find(provider: string, id: string) {
      return { provider, id };
    },
  };

  return {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getLeafId: () => "leaf-id",
      getSessionFile: () => join(cwd, ".pi", "session.jsonl"),
      getSessionId: () => "session-id",
    },
    modelRegistry,
    fork: vi.fn(
      async (_entryId: string, options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
        if (fakePi) {
          await emitFakeSessionStart(fakePi, "fork", cwd);
          await options?.withSession?.({
            cwd,
            hasUI: false,
            ui: { notify() {} },
            modelRegistry,
            sendUserMessage: fakePi.sendUserMessage,
          });
        }
        return { cancelled: false };
      },
    ),
    newSession: vi.fn(async (options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
      if (fakePi) {
        await emitFakeSessionStart(fakePi, "new", cwd);
        await options?.withSession?.({
          cwd,
          hasUI: false,
          ui: { notify() {} },
          modelRegistry,
          sendUserMessage: fakePi.sendUserMessage,
        });
      }
      return { cancelled: false };
    }),
  };
}

function createTempCwd(): string {
  return createTempDirSync("agent-gsd-command-");
}

function createPlanningFixture(cwd: string): void {
  mkdirSync(join(cwd, ".planning", "goals", "active"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "milestones", "v1.0-mvp"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "phases", "2-delivery"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "todos", "pending"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "config.json"),
    `${JSON.stringify(
      {
        model_profile: "balanced",
        commit_docs: true,
        parallelization: true,
        search_gitignored: false,
        brave_search: false,
        firecrawl: false,
        exa_search: false,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: \nstatus: Ready to plan\n",
  );
  writeFileSync(
    join(cwd, ".planning", "ROADMAP.md"),
    [
      "### Phase 1: Foundation",
      "",
      "**Goal**: foundation",
      "",
      "Plans:",
      "- [x] 1-01: done",
      "",
      "### Phase 2: Delivery",
      "",
      "**Goal**: delivery",
      "",
      "Plans:",
      "- [ ] 2-01: ship",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-01-PLAN.md"),
    "---\nphase: 2\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "todos", "pending", "20260504-ship.md"), "ship\n");
  writeFileSync(join(cwd, ".planning", "goals", "v1.0-launch.md"), "launch\n");
}

test("gsd registers grouped command", () => {
  const fakePi = new FakePi();
  gsdExtension(fakePi as ExtensionAPI);
  expect(fakePi.commands.has("gsd")).toBe(true);
});

test("gsd command enables feature with on subcommand", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({ message: "GSD enabled", level: "info" });
});

test("gsd command blocks disabled lifecycle commands", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("progress", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message: "GSD disabled. Run /gsd on.",
    level: "warning",
  });
});

test("gsd health routes --repair to bundled validator", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases"), { recursive: true });
  writeFileSync(join(cwd, ".planning", "config.json"), "{bad json\n");
  writeFileSync(
    join(cwd, ".planning", "PROJECT.md"),
    "## What This Is\n\nDemo\n\n## Core Value\n\nValue\n\n## Requirements\n\n- One\n",
  );
  writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# Roadmap\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(join(cwd, ".planning", "STATE.md"), "status: Ready to plan\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("health --repair", createCommandContext(cwd, notifications));

  expect(notifications.at(-1)?.level).toBe("warning");
  expect(notifications.at(-1)?.message).toContain("Health ");
  expect(notifications.at(-1)?.message).toContain("repairs=1");
  expect(notifications.at(-1)?.message).toContain("OK resetConfig path=config.json");
  expect(JSON.parse(await readFile(join(cwd, ".planning", "config.json"), "utf8"))).toMatchObject({
    model_profile: "balanced",
  });
});

test("gsd health routes --context to bundled context backend", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler(
    "health --context --tokens-used 650 --context-window 1000",
    createCommandContext(cwd, notifications),
  );

  expect(notifications.at(-1)).toEqual({
    message: [
      "Health context 65% warning",
      "Window: 650/1000 tokens",
      "Recommendation: Context is approaching the fracture zone — consider /gsd-thread to continue in a fresh window.",
    ].join("\n"),
    level: "warning",
  });
});

test("gsd health routes bare --context using local session usage", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("on", createCommandContext(cwd, notifications, fakePi));
  await command?.handler("health --context", {
    ...createCommandContext(cwd, notifications, fakePi),
    getContextUsage() {
      return { tokens: 450, contextWindow: 1000 };
    },
  });

  expect(notifications.at(-1)).toEqual({
    message: ["Health context 45% healthy", "Window: 450/1000 tokens"].join("\n"),
    level: "info",
  });
});

test("gsd health routes bare --context using config window fallback", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false,"context_window":1000}\n',
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("on", createCommandContext(cwd, notifications, fakePi));
  await command?.handler("health --context", createCommandContext(cwd, notifications, fakePi));

  expect(notifications.at(-1)).toEqual({
    message: [
      "Health context unknown",
      "Window: ?/1000 tokens",
      "Recommendation: token usage unavailable in current session. Re-run with --tokens-used <int> or from active session with context metrics.",
    ].join("\n"),
    level: "warning",
  });
});

test("gsd health rejects malformed context counters before bundled backend", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler(
    "health --context --tokens-used nope --context-window 1000",
    createCommandContext(cwd, notifications),
  );

  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd health flag: --tokens-used requires non-negative integer value.",
    level: "warning",
  });
});

test("gsd health parser accepts bare context mode", () => {
  expect(parseGsdCommandArgs("health --context")).toEqual({
    subcommand: "health",
    context: true,
  });
});

test("gsd health parser accepts equals-form context counters", () => {
  expect(parseGsdCommandArgs("health --context --tokens-used=650 --context-window=1000")).toEqual({
    subcommand: "health",
    context: true,
    tokensUsed: "650",
    contextWindow: "1000",
  });
});

test("gsd health parser rejects missing context counter values explicitly", () => {
  expect(parseGsdCommandArgs("health --context --tokens-used")).toEqual({
    subcommand: "health",
    context: true,
    unsupportedModeError: "Unsupported /gsd health flag: --tokens-used requires a value.",
  });
  expect(parseGsdCommandArgs("health --context --tokens-used=")).toEqual({
    subcommand: "health",
    context: true,
    unsupportedModeError: "Unsupported /gsd health flag: --tokens-used requires a value.",
  });
  expect(parseGsdCommandArgs("health --context --context-window")).toEqual({
    subcommand: "health",
    context: true,
    unsupportedModeError: "Unsupported /gsd health flag: --context-window requires a value.",
  });
  expect(parseGsdCommandArgs("health --context --context-window=")).toEqual({
    subcommand: "health",
    context: true,
    unsupportedModeError: "Unsupported /gsd health flag: --context-window requires a value.",
  });
});

test("gsd health parser rejects malformed context counter values explicitly", () => {
  expect(parseGsdCommandArgs("health --context --tokens-used nope")).toEqual({
    subcommand: "health",
    context: true,
    unsupportedModeError:
      "Unsupported /gsd health flag: --tokens-used requires non-negative integer value.",
  });
  expect(parseGsdCommandArgs("health --context --tokens-used=-1")).toEqual({
    subcommand: "health",
    context: true,
    unsupportedModeError:
      "Unsupported /gsd health flag: --tokens-used requires non-negative integer value.",
  });
  expect(parseGsdCommandArgs("health --context --context-window nope")).toEqual({
    subcommand: "health",
    context: true,
    unsupportedModeError:
      "Unsupported /gsd health flag: --context-window requires positive integer value.",
  });
  expect(parseGsdCommandArgs("health --context --context-window=0")).toEqual({
    subcommand: "health",
    context: true,
    unsupportedModeError:
      "Unsupported /gsd health flag: --context-window requires positive integer value.",
  });
});

test("gsd status routes to subagent status handler", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  setGsdSubagentSdkFactoryForTests(
    () =>
      ({
        list: () => [
          {
            sessionId: "child-1",
            sessionPath: "/tmp/child-1.jsonl",
            name: "gsd-planner",
            task: "plan phase",
            status: "running",
            startedAt: Date.now() - 65_000,
            activity: { label: "planning", detail: "Reviewing roadmap and current plan gaps" },
          },
        ],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message:
      "1 total · 1 running\n\ngsd-planner: planning · 1:05 · Reviewing roadmap and current plan gaps",
    level: "info",
  });
});

test("gsd status reports no active subagents honestly", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  setGsdSubagentSdkFactoryForTests(
    () =>
      ({
        list: () => [],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message: "0 total\n\nNo GSD subagents active.",
    level: "info",
  });
});

test("gsd status headless output summarizes completed and failed subagents", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  setGsdSubagentSdkFactoryForTests(
    () =>
      ({
        list: () => [
          {
            sessionId: "child-1",
            sessionPath: "/tmp/child-1.jsonl",
            name: "gsd-plan-checker",
            task: "check phase",
            status: "completed",
            startedAt: Date.now() - 2_000,
          },
          {
            sessionId: "child-2",
            sessionPath: "/tmp/child-2.jsonl",
            name: "gsd-debugger",
            task: "debug auth",
            status: "failed",
            startedAt: Date.now() - 1_000,
            activity: { detail: "Auth token parser crashed after retry loop" },
          },
        ],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message:
      "2 total · 2 done\n\ngsd-plan-checker: done · 0:02\ngsd-debugger: failed · 0:01 · Auth token parser crashed after retry loop",
    level: "info",
  });
});

test("gsd status headless output shows cancelled label and truncates long detail", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  setGsdSubagentSdkFactoryForTests(
    () =>
      ({
        list: () => [
          {
            sessionId: "child-1",
            sessionPath: "/tmp/child-1.jsonl",
            name: "gsd-reviewer",
            task: "review phase",
            status: "cancelled",
            startedAt: Date.now() - 3_000,
            activity: {
              detail:
                "Cancelled after a very long detail message that should be truncated before it can overwhelm the plain text status output with too much content",
            },
          },
        ],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));

  expect(notifications.at(-1)?.message).toContain("1 total · 1 done");
  expect(notifications.at(-1)?.message).toContain(
    "gsd-reviewer: cancelled · 0:03 · Cancelled after",
  );
  expect(notifications.at(-1)?.message).toContain("…");
});

test("gsd status headless output ignores blank activity labels and details", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  setGsdSubagentSdkFactoryForTests(
    () =>
      ({
        list: () => [
          {
            sessionId: "child-1",
            sessionPath: "/tmp/child-1.jsonl",
            name: "gsd-worker",
            task: "work phase",
            status: "running",
            startedAt: Date.now() - 4_000,
            activity: { label: "   ", detail: "   " },
          },
        ],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));

  expect(notifications.at(-1)).toEqual({
    message: "1 total · 1 running\n\ngsd-worker: running · 0:04",
    level: "info",
  });
});

test("gsd status headless output ignores non-GSD child sessions", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  setGsdSubagentSdkFactoryForTests(
    () =>
      ({
        list: () => [
          {
            sessionId: "child-1",
            sessionPath: "/tmp/child-1.jsonl",
            name: "worker",
            task: "generic detached task",
            status: "running",
            startedAt: Date.now() - 12_000,
            activity: { label: "working", detail: "Should stay out of /gsd status" },
          },
          {
            sessionId: "child-2",
            sessionPath: "/tmp/child-2.jsonl",
            name: "codebase-mapper:tech",
            task: "map codebase",
            status: "running",
            startedAt: Date.now() - 5_000,
            activity: { label: "mapping", detail: "Refreshing tech docs" },
          },
        ],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));

  expect(notifications.at(-1)).toEqual({
    message: "1 total · 1 running\n\ncodebase-mapper:tech: mapping · 0:05 · Refreshing tech docs",
    level: "info",
  });
});

test("gsd status headless output breaks equal start-time ties deterministically", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  const startedAt = Date.now() - 5_000;
  setGsdSubagentSdkFactoryForTests(
    () =>
      ({
        list: () => [
          {
            sessionId: "child-b",
            sessionPath: "/tmp/child-b.jsonl",
            name: "gsd-reviewer",
            task: "review phase",
            status: "running",
            startedAt,
            activity: { label: "reviewing", detail: "Second by name" },
          },
          {
            sessionId: "child-a",
            sessionPath: "/tmp/child-a.jsonl",
            name: "gsd-planner",
            task: "plan phase",
            status: "running",
            startedAt,
            activity: { label: "planning", detail: "First by name" },
          },
        ],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));

  expect(notifications.at(-1)).toEqual({
    message:
      "2 total · 2 running\n\ngsd-planner: planning · 0:05 · First by name\ngsd-reviewer: reviewing · 0:05 · Second by name",
    level: "info",
  });
});

test("gsd status headless output counts idle subagents explicitly", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  setGsdSubagentSdkFactoryForTests(
    () =>
      ({
        list: () => [
          {
            sessionId: "child-1",
            sessionPath: "/tmp/child-1.jsonl",
            name: "gsd-planner",
            task: "plan phase",
            status: "idle",
            startedAt: Date.now() - 6_000,
            activity: { label: "idle", detail: "Waiting for follow-up input" },
          },
        ],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));

  expect(notifications.at(-1)).toEqual({
    message: "1 total · 1 idle\n\ngsd-planner: idle · 0:06 · Waiting for follow-up input",
    level: "info",
  });
});

test("parseGsdCommandArgs reads positional and flag phase overrides", () => {
  expect(parseGsdCommandArgs("plan-phase 2")).toEqual({ subcommand: "plan-phase", phase: "2" });
  expect(parseGsdCommandArgs("plan-phase")).toEqual({ subcommand: "plan-phase" });
  expect(parseGsdCommandArgs("plan-phase --phase 2 --research --skip-verify")).toEqual({
    subcommand: "plan-phase",
    phase: "2",
    research: true,
    skipVerify: true,
  });
  expect(parseGsdCommandArgs("plan-phase --gaps")).toEqual({
    subcommand: "plan-phase",
    gaps: true,
  });
  expect(parseGsdCommandArgs("plan-phase --reviews")).toEqual({
    subcommand: "plan-phase",
    reviews: true,
  });
  expect(parseGsdCommandArgs("plan-phase --view")).toEqual({
    subcommand: "plan-phase",
    view: true,
    unsupportedModeError:
      "Unsupported /gsd plan-phase flag combination: --view only works with --research-phase in Slice 1.",
  });
  expect(parseGsdCommandArgs("plan-phase --research-phase 2 --view")).toEqual({
    subcommand: "plan-phase",
    researchPhase: "2",
    view: true,
  });
  expect(parseGsdCommandArgs("plan-phase --skip-research --text 2")).toEqual({
    subcommand: "plan-phase",
    phase: "2",
    skipResearch: true,
    text: true,
  });
  expect(parseGsdCommandArgs("plan-phase --auto 2")).toEqual({
    subcommand: "plan-phase",
    phase: "2",
    unsupportedModeError: "Unsupported /gsd plan-phase flag: --auto. Deferred in Slice 1.",
  });
  expect(parseGsdCommandArgs("plan-phase --chain 2")).toEqual({
    subcommand: "plan-phase",
    phase: "2",
    unsupportedModeError: "Unsupported /gsd plan-phase flag: --chain. Deferred in Slice 1.",
  });
  expect(parseGsdCommandArgs("plan-phase --tdd 2")).toEqual({
    subcommand: "plan-phase",
    phase: "2",
    unsupportedModeError: "Unsupported /gsd plan-phase flag: --tdd. Deferred in Slice 1.",
  });
  expect(parseGsdCommandArgs("execute-phase --phase 3.1")).toEqual({
    subcommand: "execute-phase",
    phase: "3.1",
  });
  expect(
    parseGsdCommandArgs("execute-phase 3.1 --wave 2 --gaps-only --interactive --validate"),
  ).toEqual({
    subcommand: "execute-phase",
    phase: "3.1",
    wave: "2",
    gapsOnly: true,
    interactive: true,
    validate: true,
  });
  expect(parseGsdCommandArgs("execute-phase 3.1 --cross-ai")).toEqual({
    subcommand: "execute-phase",
    phase: "3.1",
    crossAi: true,
  });
  expect(parseGsdCommandArgs("execute-phase 3.1 --no-cross-ai")).toEqual({
    subcommand: "execute-phase",
    phase: "3.1",
    noCrossAi: true,
  });
  expect(parseGsdCommandArgs("execute-phase 3.1 --auto --mvp --tdd")).toEqual({
    subcommand: "execute-phase",
    phase: "3.1",
    auto: true,
    mvp: true,
    tdd: true,
  });
  expect(parseGsdCommandArgs("execute-phase --wave=3 4")).toEqual({
    subcommand: "execute-phase",
    phase: "4",
    wave: "3",
  });
  expect(parseGsdCommandArgs("verify-work 2")).toEqual({ subcommand: "verify-work", phase: "2" });
  expect(parseGsdCommandArgs("verify-work --phase 2")).toEqual({
    subcommand: "verify-work",
    phase: "2",
  });
  expect(parseGsdCommandArgs("verify-work 1 junk")).toEqual({
    subcommand: "verify-work",
    phase: "1",
    unsupportedModeError: "Unsupported /gsd verify-work extra positional argument: junk.",
  });
  expect(parseGsdCommandArgs("verify-work --bogus")).toEqual({
    subcommand: "verify-work",
    unsupportedModeError: "Unsupported /gsd verify-work flag: --bogus.",
  });
  expect(parseGsdCommandArgs("verify-work --interactive 1")).toEqual({
    subcommand: "verify-work",
    phase: "1",
    unsupportedModeError: "Unsupported /gsd verify-work flag: --interactive.",
  });
  expect(parseGsdCommandArgs("secure-phase 2")).toEqual({ subcommand: "secure-phase", phase: "2" });
  expect(parseGsdCommandArgs("secure-phase --phase 2")).toEqual({
    subcommand: "secure-phase",
    phase: "2",
  });
  expect(parseGsdCommandArgs("secure-phase 1 junk")).toEqual({
    subcommand: "secure-phase",
    phase: "1",
    unsupportedModeError: "Unsupported /gsd secure-phase extra positional argument: junk.",
  });
  expect(parseGsdCommandArgs("secure-phase --bogus")).toEqual({
    subcommand: "secure-phase",
    unsupportedModeError: "Unsupported /gsd secure-phase flag: --bogus.",
  });
  expect(parseGsdCommandArgs("secure-phase --phase")).toEqual({
    subcommand: "secure-phase",
    unsupportedModeError: "Unsupported /gsd secure-phase flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("secure-phase --phase=")).toEqual({
    subcommand: "secure-phase",
    unsupportedModeError: "Unsupported /gsd secure-phase flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("validate-phase 2")).toEqual({
    subcommand: "validate-phase",
    phase: "2",
  });
  expect(parseGsdCommandArgs("validate-phase --phase 2")).toEqual({
    subcommand: "validate-phase",
    phase: "2",
  });
  expect(parseGsdCommandArgs("validate-phase 1 junk")).toEqual({
    subcommand: "validate-phase",
    phase: "1",
    unsupportedModeError: "Unsupported /gsd validate-phase extra positional argument: junk.",
  });
  expect(parseGsdCommandArgs("validate-phase --bogus")).toEqual({
    subcommand: "validate-phase",
    unsupportedModeError: "Unsupported /gsd validate-phase flag: --bogus.",
  });
  expect(parseGsdCommandArgs("validate-phase --phase")).toEqual({
    subcommand: "validate-phase",
    unsupportedModeError: "Unsupported /gsd validate-phase flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("validate-phase --phase=")).toEqual({
    subcommand: "validate-phase",
    unsupportedModeError: "Unsupported /gsd validate-phase flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("execute-phase 2 junk")).toEqual({
    subcommand: "execute-phase",
    phase: "2",
    unsupportedModeError: "Unsupported /gsd execute-phase extra positional argument: junk.",
  });
  expect(parseGsdCommandArgs("execute-phase --phase 2 3")).toEqual({
    subcommand: "execute-phase",
    phase: "2",
    unsupportedModeError: "Unsupported /gsd execute-phase extra positional argument: 3.",
  });
  expect(parseGsdCommandArgs("execute-phase 2 --wave 0")).toEqual({
    subcommand: "execute-phase",
    phase: "2",
    unsupportedModeError:
      "Unsupported /gsd execute-phase flag: --wave requires positive integer value.",
  });
  expect(parseGsdCommandArgs("execute-phase 2 --wave=abc")).toEqual({
    subcommand: "execute-phase",
    phase: "2",
    unsupportedModeError:
      "Unsupported /gsd execute-phase flag: --wave requires positive integer value.",
  });
  expect(parseGsdCommandArgs("next --phase=4")).toEqual({ subcommand: "next", phase: "4" });
  expect(parseGsdCommandArgs("next --force --phase=4")).toEqual({
    subcommand: "next",
    phase: "4",
    force: true,
  });
  expect(parseGsdCommandArgs("next --phase")).toEqual({
    subcommand: "next",
    unsupportedModeError: "Unsupported /gsd next flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("next --phase=")).toEqual({
    subcommand: "next",
    unsupportedModeError: "Unsupported /gsd next flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("next --phase --force")).toEqual({
    subcommand: "next",
    force: true,
    unsupportedModeError: "Unsupported /gsd next flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("next --phase=--force")).toEqual({
    subcommand: "next",
    unsupportedModeError: "Unsupported /gsd next flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("progress --next")).toEqual({
    subcommand: "progress",
    next: true,
  });
  expect(parseGsdCommandArgs("progress --next --force")).toEqual({
    subcommand: "progress",
    next: true,
    force: true,
  });
  expect(parseGsdCommandArgs("progress --force")).toEqual({
    subcommand: "progress",
    force: true,
    unsupportedModeError: "Unsupported /gsd progress flag: --force requires --next.",
  });
  expect(parseGsdCommandArgs("progress --phase 2 --next")).toEqual({
    subcommand: "progress",
    phase: "2",
    next: true,
  });
  expect(parseGsdCommandArgs("progress --next --phase")).toEqual({
    subcommand: "progress",
    next: true,
    unsupportedModeError: "Unsupported /gsd progress flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("progress --next --phase=")).toEqual({
    subcommand: "progress",
    next: true,
    unsupportedModeError: "Unsupported /gsd progress flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("progress --phase --next")).toEqual({
    subcommand: "progress",
    next: true,
    unsupportedModeError: "Unsupported /gsd progress flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("progress --next --phase=--forensic")).toEqual({
    subcommand: "progress",
    next: true,
    unsupportedModeError: "Unsupported /gsd progress flag: --phase requires a value.",
  });
  expect(parseGsdCommandArgs("progress 2")).toEqual({
    subcommand: "progress",
    phase: "2",
    unsupportedModeError:
      "Unsupported /gsd progress phase override: use --next with a positional phase or --phase.",
  });
  expect(parseGsdCommandArgs("progress --phase 2")).toEqual({
    subcommand: "progress",
    phase: "2",
    unsupportedModeError:
      "Unsupported /gsd progress phase override: use --next with a positional phase or --phase.",
  });
  expect(parseGsdCommandArgs("progress --do")).toEqual({
    subcommand: "progress",
    doMode: true,
    unsupportedModeError:
      "Unsupported /gsd progress mode: --do. Local command does not implement routed execution from progress yet.",
  });
  expect(parseGsdCommandArgs("progress --forensic")).toEqual({
    subcommand: "progress",
    forensic: true,
    unsupportedModeError:
      "Unsupported /gsd progress mode: --forensic. Local command does not implement forensic workflow routing yet.",
  });
  expect(parseGsdCommandArgs("progress --bogus")).toEqual({
    subcommand: "progress",
    unsupportedModeError: "Unsupported /gsd progress flag: --bogus.",
  });
  expect(parseGsdCommandArgs("stats json")).toEqual({ subcommand: "stats", outputMode: "json" });
  expect(parseGsdCommandArgs("stats table")).toEqual({
    subcommand: "stats",
    outputMode: "table",
  });
  expect(parseGsdCommandArgs("stats --json")).toEqual({
    subcommand: "stats",
    outputMode: "json",
  });
  expect(parseGsdCommandArgs("stats --table")).toEqual({
    subcommand: "stats",
    outputMode: "table",
  });
  expect(parseGsdCommandArgs("stats --format json")).toEqual({
    subcommand: "stats",
    outputMode: "json",
  });
  expect(parseGsdCommandArgs("stats --format=table")).toEqual({
    subcommand: "stats",
    outputMode: "table",
  });
  expect(parseGsdCommandArgs("stats --format")).toEqual({
    subcommand: "stats",
    unsupportedModeError: "Unsupported /gsd stats format: .",
  });
  expect(parseGsdCommandArgs("stats --format csv")).toEqual({
    subcommand: "stats",
    unsupportedModeError: "Unsupported /gsd stats format: csv.",
  });
  expect(parseGsdCommandArgs("stats --json table")).toEqual({
    subcommand: "stats",
    outputMode: "json",
    unsupportedModeError: "Unsupported /gsd stats mode: multiple output modes requested.",
  });
  expect(parseGsdCommandArgs("stats --bogus")).toEqual({
    subcommand: "stats",
    unsupportedModeError: "Unsupported /gsd stats flag: --bogus.",
  });
  expect(parseGsdCommandArgs("map-codebase --paths src,packages/ui")).toEqual({
    subcommand: "map-codebase",
    paths: ["src", "packages/ui"],
  });
  expect(parseGsdCommandArgs("map-codebase --paths=apps/web,packages/api")).toEqual({
    subcommand: "map-codebase",
    paths: ["apps/web", "packages/api"],
  });
  expect(parseGsdCommandArgs("map-codebase --fast --focus tech")).toEqual({
    subcommand: "map-codebase",
    fast: true,
    focus: "tech",
  });
  expect(parseGsdCommandArgs("map-codebase --query status")).toEqual({
    subcommand: "map-codebase",
    query: "status",
  });
  expect(parseGsdCommandArgs("map-codebase --query auth service")).toEqual({
    subcommand: "map-codebase",
    query: "auth service",
  });
  expect(parseGsdCommandArgs("map-codebase --query query status page")).toEqual({
    subcommand: "map-codebase",
    query: "status page",
  });
  expect(parseGsdCommandArgs("map-codebase --query=query refresh token")).toEqual({
    subcommand: "map-codebase",
    query: "refresh token",
  });
  expect(parseGsdCommandArgs("map-codebase --query=status auth service")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase query mode: reserved query `status` does not accept trailing arguments (auth service).",
  });
  expect(parseGsdCommandArgs("map-codebase --query query")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase query mode: `--query query` requires a search term.",
  });
  expect(parseGsdCommandArgs("map-codebase refresh --paths src")).toEqual({
    subcommand: "map-codebase",
    existingMode: "refresh",
    paths: ["src"],
  });
  expect(parseGsdCommandArgs("map-codebase --query status --fast")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase query mode: reserved query `status` does not accept trailing arguments (--fast).",
  });
  expect(parseGsdCommandArgs("map-codebase --query status --focus tech")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase query mode: reserved query `status` does not accept trailing arguments (--focus tech).",
  });
  expect(parseGsdCommandArgs("map-codebase --query status --paths src")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase query mode: reserved query `status` does not accept trailing arguments (--paths src).",
  });
  expect(parseGsdCommandArgs("map-codebase --query status refresh")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase query mode: reserved query `status` does not accept trailing arguments (refresh).",
  });
  expect(parseGsdCommandArgs("map-codebase --query diff --paths src")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase query mode: reserved query `diff` does not accept trailing arguments (--paths src).",
  });
  expect(parseGsdCommandArgs("map-codebase --query refresh now")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase query mode: reserved query `refresh` does not accept trailing arguments (now).",
  });
  expect(parseGsdCommandArgs("map-codebase --query refresh")).toEqual({
    subcommand: "map-codebase",
    query: "refresh",
  });
  expect(parseGsdCommandArgs("map-codebase auth")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase argument: auth. Local command does not support positional area scoping.",
  });
  expect(parseGsdCommandArgs("map-codebase --focus foo")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError: "Unsupported /gsd map-codebase mode: --focus foo.",
  });
  expect(parseGsdCommandArgs("map-codebase --query=")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError: "Unsupported /gsd map-codebase mode: --query requires a value.",
  });
  expect(parseGsdCommandArgs("map-codebase --paths")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase mode: --paths requires at least one repo-relative path.",
  });
  expect(parseGsdCommandArgs("map-codebase --paths=")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError:
      "Unsupported /gsd map-codebase mode: --paths requires at least one repo-relative path.",
  });
  expect(parseGsdCommandArgs("map-codebase --bogus")).toEqual({
    subcommand: "map-codebase",
    unsupportedModeError: "Unsupported /gsd map-codebase flag: --bogus.",
  });
  expect(parseGsdCommandArgs("map-codebase skip refresh")).toEqual({
    subcommand: "map-codebase",
    existingMode: "skip",
    unsupportedModeError:
      "Unsupported /gsd map-codebase arguments: cannot combine skip with refresh.",
  });
  expect(parseGsdCommandArgs("new-milestone v1.1 Notifications")).toEqual({
    subcommand: "new-milestone",
    milestone: "v1.1 Notifications",
  });
  expect(parseGsdCommandArgs("new-project --auto @idea.md")).toEqual({
    subcommand: "new-project",
    auto: true,
    input: "@idea.md",
  });
  expect(parseGsdCommandArgs("complete-milestone v1.1")).toEqual({
    subcommand: "complete-milestone",
    version: "v1.1",
  });
  expect(parseGsdCommandArgs("milestone-summary v1.0")).toEqual({
    subcommand: "milestone-summary",
    version: "v1.0",
  });
  expect(parseGsdCommandArgs("debug --diagnose login fails on mobile safari")).toEqual({
    subcommand: "debug",
    debugAction: "start",
    diagnose: true,
    description: "login fails on mobile safari",
  });
  expect(parseGsdCommandArgs("debug status auth-token-null")).toEqual({
    subcommand: "debug",
    debugAction: "status",
    slug: "auth-token-null",
    diagnose: false,
  });
  expect(parseGsdCommandArgs("discuss-phase --phase 2 --assumptions --all --chain --text")).toEqual(
    {
      subcommand: "discuss-phase",
      phase: "2",
      assumptions: true,
      all: true,
      chain: true,
      text: true,
    },
  );
  expect(parseGsdCommandArgs("discuss-phase --phase 2 --all")).toEqual({
    subcommand: "discuss-phase",
    phase: "2",
    all: true,
  });
  expect(parseGsdCommandArgs("discuss-phase --phase 2 --auto")).toEqual({
    subcommand: "discuss-phase",
    phase: "2",
    auto: true,
  });
  expect(parseGsdCommandArgs("discuss-phase --batch --phase 2")).toEqual({
    subcommand: "discuss-phase",
    phase: "2",
    batch: true,
    unsupportedModeError:
      "Unsupported /gsd discuss-phase mode: --batch overlay is parsed but not implemented in Slice 1.",
  });
  expect(parseGsdCommandArgs("discuss-phase --text --auto")).toEqual({
    subcommand: "discuss-phase",
    text: true,
    auto: true,
  });
  expect(parseGsdCommandArgs("discuss-phase --phase 2 --text Skip prior context")).toEqual({
    subcommand: "discuss-phase",
    phase: "2",
    text: true,
    input: "Skip prior context",
  });
});

test("gsd autocomplete suggests phase values and flags from ctx cwd state", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  const executePhaseItems = await command?.getArgumentCompletions?.("execute-phase ");
  expect(executePhaseItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "execute-phase 2",
        label: "2 Delivery",
        description: expect.stringContaining("open"),
      }),
      expect.objectContaining({
        value: "execute-phase --phase",
        label: "--phase",
      }),
      expect.objectContaining({
        value: "execute-phase --phase=",
        label: "--phase=",
      }),
      expect.objectContaining({
        value: "execute-phase --wave",
        label: "--wave",
      }),
      expect.objectContaining({
        value: "execute-phase --gaps-only",
        label: "--gaps-only",
      }),
      expect.objectContaining({
        value: "execute-phase --interactive",
        label: "--interactive",
      }),
      expect.objectContaining({
        value: "execute-phase --cross-ai",
        label: "--cross-ai",
      }),
      expect.objectContaining({
        value: "execute-phase --no-cross-ai",
        label: "--no-cross-ai",
      }),
    ]),
  );

  const phaseFlagItems = await command?.getArgumentCompletions?.("execute-phase --phase ");
  expect(phaseFlagItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "execute-phase --phase 1", label: "1 Foundation" }),
      expect.objectContaining({ value: "execute-phase --phase 2", label: "2 Delivery" }),
    ]),
  );

  const phaseEqualsItems = await command?.getArgumentCompletions?.("execute-phase --phase=");
  expect(phaseEqualsItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "execute-phase --phase=1", label: "1 Foundation" }),
      expect.objectContaining({ value: "execute-phase --phase=2", label: "2 Delivery" }),
    ]),
  );

  const waveFlagItems = await command?.getArgumentCompletions?.("execute-phase --wave ");
  expect(waveFlagItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "execute-phase --wave 1", label: "Wave 1" }),
      expect.objectContaining({ value: "execute-phase --wave 2", label: "Wave 2" }),
    ]),
  );

  const waveEqualsItems = await command?.getArgumentCompletions?.("execute-phase --wave=");
  expect(waveEqualsItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "execute-phase --wave=1", label: "Wave 1" }),
      expect.objectContaining({ value: "execute-phase --wave=2", label: "Wave 2" }),
    ]),
  );

  const discussItems = await command?.getArgumentCompletions?.("discuss-phase ");
  expect(discussItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "discuss-phase --all", label: "--all" }),
      expect.objectContaining({ value: "discuss-phase --auto", label: "--auto" }),
      expect.objectContaining({ value: "discuss-phase --assumptions", label: "--assumptions" }),
      expect.objectContaining({ value: "discuss-phase --text", label: "--text" }),
    ]),
  );

  const discussTextItems = await command?.getArgumentCompletions?.("discuss-phase --t");
  expect(discussTextItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "discuss-phase --text", label: "--text" }),
    ]),
  );

  const mapCodebaseItems = await command?.getArgumentCompletions?.("map-codebase ");
  expect(mapCodebaseItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "map-codebase refresh",
        label: "refresh",
      }),
      expect.objectContaining({
        value: "map-codebase update",
        label: "update",
      }),
      expect.objectContaining({
        value: "map-codebase skip",
        label: "skip",
        description: expect.stringContaining("Unavailable"),
      }),
      expect.objectContaining({
        value: "map-codebase --fast",
        label: "--fast",
        description: expect.stringContaining("partial non-canonical"),
      }),
      expect.objectContaining({
        value: "map-codebase --query",
        label: "--query",
        description: expect.stringContaining("intel query or refresh mode"),
      }),
    ]),
  );

  const mapCodebaseQueryItems = await command?.getArgumentCompletions?.("map-codebase --query ");
  expect(mapCodebaseQueryItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "map-codebase --query query ", label: "query" }),
      expect.objectContaining({ value: "map-codebase --query status", label: "status" }),
      expect.objectContaining({ value: "map-codebase --query diff", label: "diff" }),
      expect.objectContaining({ value: "map-codebase --query refresh", label: "refresh" }),
    ]),
  );

  const mapCodebaseQueryAfterFreeformItems = await command?.getArgumentCompletions?.(
    "map-codebase --query auth ",
  );
  expect(mapCodebaseQueryAfterFreeformItems).toBeNull();

  const mapCodebaseQueryAfterEscapeItems = await command?.getArgumentCompletions?.(
    "map-codebase --query query status ",
  );
  expect(mapCodebaseQueryAfterEscapeItems).toBeNull();

  const mapCodebaseFocusItems = await command?.getArgumentCompletions?.(
    "map-codebase --fast --focus ",
  );
  expect(mapCodebaseFocusItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "map-codebase --fast --focus tech",
        label: "tech",
        description: expect.stringContaining("STACK.md"),
      }),
      expect.objectContaining({
        value: "map-codebase --fast --focus tech+arch",
        label: "tech+arch",
        description: expect.stringContaining("ARCHITECTURE.md"),
      }),
    ]),
  );

  const mapCodebaseInlineFocusItems = await command?.getArgumentCompletions?.(
    "map-codebase --fast --focus=",
  );
  expect(mapCodebaseInlineFocusItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "map-codebase --fast --focus=quality", label: "quality" }),
      expect.objectContaining({
        value: "map-codebase --fast --focus=concerns",
        label: "concerns",
      }),
    ]),
  );

  const mapCodebaseFastItems = await command?.getArgumentCompletions?.("map-codebase --fast ");
  expect(mapCodebaseFastItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "map-codebase --fast refresh",
        label: "refresh",
        description: expect.stringContaining("target docs"),
      }),
      expect.objectContaining({ value: "map-codebase --fast --focus", label: "--focus" }),
    ]),
  );
  expect(mapCodebaseFastItems).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "map-codebase --fast update" }),
      expect.objectContaining({ value: "map-codebase --fast skip" }),
    ]),
  );

  const mapCodebaseNonFastFocusItems =
    await command?.getArgumentCompletions?.("map-codebase --focus ");
  expect(mapCodebaseNonFastFocusItems).toBeNull();

  const completeMilestoneItems = await command?.getArgumentCompletions?.("complete-milestone ");
  expect(completeMilestoneItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "complete-milestone v1.0", label: "v1.0" }),
    ]),
  );

  const planItems = await command?.getArgumentCompletions?.("plan-phase ");
  expect(planItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "plan-phase --gaps", label: "--gaps" }),
      expect.objectContaining({ value: "plan-phase --reviews", label: "--reviews" }),
    ]),
  );

  const debugItems = await command?.getArgumentCompletions?.("debug ");
  expect(debugItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "debug list", label: "list" }),
      expect.objectContaining({ value: "debug status ", label: "status" }),
      expect.objectContaining({ value: "debug continue ", label: "continue" }),
      expect.objectContaining({ value: "debug --diagnose", label: "--diagnose" }),
    ]),
  );

  mkdirSync(join(cwd, ".planning", "debug"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "debug", "auth-token-null.md"),
    "---\nstatus: investigating\ntrigger: auth fails\ncreated: 2026-04-11\nupdated: 2026-04-12\n---\n\n## Current Focus\n\n- hypothesis: token parse broken\n- next_action: add logging\n",
  );

  const debugStatusItems = await command?.getArgumentCompletions?.("debug status ");
  expect(debugStatusItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "debug status auth-token-null",
        label: "auth-token-null",
      }),
    ]),
  );

  writeFileSync(
    join(cwd, ".planning", "debug", "parser-crash.md"),
    "---\nslug: parser-crash\nstatus: investigating\ntrigger: parser crash\ngoal: find_and_fix\ncreated: 2026-05-06\nupdated: 2026-05-06T00:25:00Z\n---\n\n## Current Focus\n\n- hypothesis: schema too strict\n- next_action: widen frontmatter schema\n",
  );

  const debugItemsWithExtendedFrontmatter =
    await command?.getArgumentCompletions?.("debug status ");
  expect(debugItemsWithExtendedFrontmatter).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "debug status parser-crash",
        label: "parser-crash",
      }),
    ]),
  );

  const progressItems = await command?.getArgumentCompletions?.("progress ");
  expect(progressItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "progress --next", label: "--next" }),
    ]),
  );
  expect(progressItems).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "progress --phase" }),
      expect.objectContaining({ value: "progress --phase=" }),
      expect.objectContaining({ value: "progress --force" }),
    ]),
  );

  const progressNextItems = await command?.getArgumentCompletions?.("progress --next ");
  expect(progressNextItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "progress --next 1", label: "1 Foundation" }),
      expect.objectContaining({ value: "progress --next 2", label: "2 Delivery" }),
      expect.objectContaining({ value: "progress --next --phase", label: "--phase" }),
      expect.objectContaining({ value: "progress --next --phase=", label: "--phase=" }),
      expect.objectContaining({ value: "progress --next --force", label: "--force" }),
    ]),
  );

  const progressTopLevelPhaseItems = await command?.getArgumentCompletions?.("progress --phase=");
  expect(progressTopLevelPhaseItems).toBeNull();

  const progressNextPhaseItems = await command?.getArgumentCompletions?.(
    "progress --next --phase=",
  );
  expect(progressNextPhaseItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "progress --next --phase=1", label: "1 Foundation" }),
      expect.objectContaining({ value: "progress --next --phase=2", label: "2 Delivery" }),
    ]),
  );
});

test("gsd autocomplete shows dynamic subcommand hints", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  mkdirSync(join(cwd, ".planning", "debug"), { recursive: true });
  writeFileSync(join(cwd, ".planning", "debug", "legacy.md"), "legacy debug note\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  const rootItems = await command?.getArgumentCompletions?.("");
  expect(rootItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "execute-phase",
        description: expect.stringContaining("exec 2 2-01"),
      }),
      expect.objectContaining({
        value: "progress",
        description: expect.stringContaining("%"),
      }),
      expect.objectContaining({
        value: "health",
        description: expect.stringContaining("issues"),
      }),
      expect.objectContaining({
        value: "debug",
        description: expect.stringContaining("0 active sessions"),
      }),
    ]),
  );
});

test("gsd autocomplete health hint preserves degraded state", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "PROJECT.md"),
    "## What This Is\n\nDemo\n\n## Core Value\n\nValue\n\n## Requirements\n\n- One\n",
  );
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  const rootItems = await command?.getArgumentCompletions?.("");
  expect(rootItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "health",
        description: expect.stringContaining("degraded"),
      }),
    ]),
  );
});

test("gsd autocomplete matches subcommands like upstream pi fuzzy search", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  const items = await command?.getArgumentCompletions?.("dg");
  expect(items?.map((item) => item.value)).toEqual(["debug"]);
});

test("gsd next routes explicit phase override to execute-phase workflow", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next --phase 2", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 2"',
  );
});

test("gsd progress --next routes through next behavior to execute-phase workflow", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress --next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 2"',
  );
});

test("gsd progress default routes to bundled progress workflow-launch session", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress", createCommandContext(cwd, notifications, fakePi));
  const prompt = String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0] ?? "");
  expect(prompt).toContain('Launch native GSD workflow for "/gsd progress"');
  expect(prompt).toContain(resolveGsdBundlePath("commands/gsd/progress.md"));
  expect(prompt).toContain(resolveGsdBundlePath("workflows/progress.md"));
});

test("gsd progress fails closed without workflow session support", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await expect(command?.handler("progress", noSessionContext)).resolves.toBeUndefined();
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Cannot run /gsd progress: workflow session support unavailable in this context.",
    level: "warning",
  });
});

test("gsd progress fails closed when PROJECT.md is missing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases"), { recursive: true });
  writeFileSync(join(cwd, ".planning", "config.json"), "{}\n");
  writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# Roadmap\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(join(cwd, ".planning", "STATE.md"), "status: Ready to plan\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress", createCommandContext(cwd, notifications, fakePi));
  expect(notifications.at(-1)).toEqual({
    message: "Cannot run /gsd progress: missing .planning/PROJECT.md.",
    level: "warning",
  });
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
});

test("gsd progress fails closed when ROADMAP.md is missing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases"), { recursive: true });
  writeFileSync(join(cwd, ".planning", "config.json"), "{}\n");
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(join(cwd, ".planning", "STATE.md"), "status: Ready to plan\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress", createCommandContext(cwd, notifications, fakePi));
  expect(notifications.at(-1)).toEqual({
    message: "Cannot run /gsd progress: missing .planning/ROADMAP.md.",
    level: "warning",
  });
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
});

test("gsd progress fails closed when STATE.md is missing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases"), { recursive: true });
  writeFileSync(join(cwd, ".planning", "config.json"), "{}\n");
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# Roadmap\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress", createCommandContext(cwd, notifications, fakePi));
  expect(notifications.at(-1)).toEqual({
    message: "Cannot run /gsd progress: missing .planning/STATE.md.",
    level: "warning",
  });
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
});

test("gsd progress fails closed when helper returns invalid init payload", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  setProgressExecFileSyncForTests(() => '{"project_exists":true}\n' as never);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress", createCommandContext(cwd, notifications, fakePi));
  expect(notifications.at(-1)).toEqual({
    message: "Cannot run /gsd progress: helper returned invalid init progress payload.",
    level: "warning",
  });
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
});

test("gsd progress fails closed when helper init throws", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  setProgressExecFileSyncForTests(() => {
    throw new Error("helper exploded");
  });
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress", createCommandContext(cwd, notifications, fakePi));
  expect(notifications.at(-1)).toEqual({
    message: "Cannot run /gsd progress: helper exploded.",
    level: "warning",
  });
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
});

test("gsd progress --next prefers earliest incomplete phase when state drifted ahead", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 2\ncurrent_phase_name: Delivery\ncurrent_plan: 2-01\nstatus: Ready to execute\n",
  );
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-02-PLAN.md"),
    "---\nphase: 1\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-02-SUMMARY.md"), "summary\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress --next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 1"',
  );
});

test("gsd next respects padded state current_phase when earlier work is complete", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 02\ncurrent_phase_name: Delivery\ncurrent_plan: 02-01\nstatus: Ready to execute\n",
  );
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/a.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-02-PLAN.md"),
    "---\nphase: 1\nplan: 02\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/b.ts]\nautonomous: true\nmust_haves: [done]\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-02-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 2"',
  );
});

test("gsd progress rejects unsupported routed modes explicitly", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress --forensic", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message:
      "Unsupported /gsd progress mode: --forensic. Local command does not implement forensic workflow routing yet.",
    level: "warning",
  });
});

test("gsd progress rejects force without next explicitly", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress --force", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd progress flag: --force requires --next.",
    level: "warning",
  });
});

test("gsd progress rejects phase override without --next", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress 2", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message:
      "Unsupported /gsd progress phase override: use --next with a positional phase or --phase.",
    level: "warning",
  });
  await command?.handler("progress --phase 2", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message:
      "Unsupported /gsd progress phase override: use --next with a positional phase or --phase.",
    level: "warning",
  });
});

test("gsd progress rejects malformed phase override explicitly", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress --next --phase", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd progress flag: --phase requires a value.",
    level: "warning",
  });
  await command?.handler("progress --next --phase=", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd progress flag: --phase requires a value.",
    level: "warning",
  });
  await command?.handler("progress --phase --next", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd progress flag: --phase requires a value.",
    level: "warning",
  });
  await command?.handler(
    "progress --next --phase=--forensic",
    createCommandContext(cwd, notifications),
  );
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd progress flag: --phase requires a value.",
    level: "warning",
  });
});

test("gsd progress --next rejects unknown phase override without mutating state", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const before = await readFile(join(cwd, ".planning", "STATE.md"), "utf8");
  await command?.handler("progress --next --phase 99", createCommandContext(cwd, notifications));
  const after = await readFile(join(cwd, ".planning", "STATE.md"), "utf8");
  expect(after).toBe(before);
  expect(notifications.at(-1)).toEqual({
    message: "Unknown /gsd next phase override: 99.",
    level: "warning",
  });
});

test("gsd progress --next accepts zero-padded phase override", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler(
    "progress --next --phase 02",
    createCommandContext(cwd, notifications, fakePi),
  );
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 2"',
  );
});

test("gsd next accepts zero-padded phase override", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next --phase 02", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 2"',
  );
});

test("gsd progress --next --force still blocks paused checkpoint markers", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", ".continue-here.md"),
    [
      "# Resume",
      "",
      "| Requirement | Status | Blocking Issue |",
      "| --- | --- | --- |",
      "| Delivery | pending | waiting on user checkpoint |",
    ].join("\n"),
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler(
    "progress --next --force",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by .continue-here.md; resume pending work before /gsd next",
    level: "warning",
  });
});

test("gsd progress --next --force still blocks paused state", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 01-01\nstatus: Paused for review\npaused_at: 2026-05-08T12:00:00Z\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler(
    "progress --next --force",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by paused state at 2026-05-08T12:00:00Z",
    level: "warning",
  });
});

test("gsd progress --next --force still blocks unresolved verification fail", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-VERIFICATION.md"),
    "---\nverified: false\n---\n\n# Verification\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler(
    "progress --next --force",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by unresolved verification FAIL in phase 1; rerun /gsd verify-work 1",
    level: "warning",
  });
});

test("gsd progress --next --force still blocks discuss checkpoints", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "DISCUSS-CHECKPOINT.json"),
    JSON.stringify({ phase: "1" }),
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler(
    "progress --next --force",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by discuss checkpoint in phase 1; resume with /gsd discuss-phase 1",
    level: "warning",
  });
});

test("gsd progress --next can route discuss-phase without workflow session", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  rmSync(join(cwd, ".planning", "phases", "2-delivery"), { recursive: true, force: true });
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await command?.handler("progress --next", noSessionContext);

  expect(
    notifications.some((item) => item.message.includes("Next requires workflow session")),
  ).toBe(false);
  expect(notifications.at(-1)).toEqual({
    message:
      "Existing context for phase 2\n\nOptions:\n- Use existing context\n- View context summary\n- Skip prior context",
    level: "info",
  });
});

test("gsd progress --next can route plan-phase without workflow session", async () => {
  const spawn = vi.fn(async (request: { name?: string; outputFormat?: { type: string } }) => {
    if (request.outputFormat?.type === "json_schema") {
      if (request.name === "gsd-planner") {
        return {
          ok: true,
          value: {
            structured: {
              status: "created",
              summary: "created",
            },
          },
        };
      }

      return {
        ok: true,
        value: {
          structured: {
            approved: true,
            summary: "approved",
            issues: [],
          },
        },
      };
    }

    const planPath = join(cwd, ".planning", "phases", "2-delivery", "02-01-PLAN.md");
    if (!existsSync(planPath)) {
      writeFileSync(
        planPath,
        [
          "---",
          "phase: 02",
          "plan: 01",
          "type: build",
          "wave: 1",
          "depends_on: []",
          "files_modified: []",
          "autonomous: true",
          "must_haves: [ship]",
          "---",
          "",
          "# Plan",
          "",
          "## Tasks",
          "",
          "### Task 1: Ship",
          "",
          "Do work.",
        ].join("\n"),
      );
    }

    return {
      ok: true,
      value: {
        handle: {
          sessionId: "stub-session",
          async waitForCompletion() {
            return { sessionId: "stub-session", status: "completed", summary: "ok" };
          },
          async captureOutput() {
            return { text: "", truncated: false };
          },
        },
      },
    };
  });
  setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  rmSync(join(cwd, ".planning", "phases", "2-delivery", "2-01-PLAN.md"), { force: true });
  writeFileSync(join(cwd, ".planning", "phases", "2-delivery", "2-CONTEXT.md"), "# Context\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    modelRegistry: {
      find(provider: string, id: string) {
        return { provider, id };
      },
    },
  };

  await command?.handler("progress --next", noSessionContext);

  expect(
    notifications.some((item) => item.message.includes("Next requires workflow session")),
  ).toBe(false);
  expect(spawn).toHaveBeenCalled();
});

test("gsd progress --next fails closed without workflow session for verify-work route", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "phases", "2-delivery", "2-01-SUMMARY.md"), "summary\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await command?.handler("progress --next", noSessionContext);

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message:
      "Next requires workflow session for /gsd verify-work 2. Cannot safely fall back to pointer-only state updates.",
    level: "warning",
  });
});

test("gsd progress --next ignores malformed summary ids before verify-work routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "phases", "2-delivery"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
  );
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 1-01\nstatus: Ready to execute\n",
  );
  writeFileSync(
    join(cwd, ".planning", "ROADMAP.md"),
    [
      "### Phase 1: Foundation",
      "",
      "**Goal**: foundation",
      "",
      "Plans:",
      "- [ ] 1-01: build",
      "",
      "### Phase 2: Delivery",
      "",
      "**Goal**: delivery",
      "",
      "Plans:",
      "- [ ] 2-01: ship",
      "",
    ].join("\n"),
  );
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-extra-SUMMARY.md"), "junk\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-01-PLAN.md"),
    "---\nphase: 2\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress --next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 1"',
  );
});

test("gsd progress --next ignores noncanonical UAT artifacts before later-phase routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "phases", "2-delivery"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
  );
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 1-01\nstatus: Ready to execute\n",
  );
  writeFileSync(
    join(cwd, ".planning", "ROADMAP.md"),
    [
      "### Phase 1: Foundation",
      "",
      "**Goal**: foundation",
      "",
      "Plans:",
      "- [ ] 1-01: build",
      "",
      "### Phase 2: Delivery",
      "",
      "**Goal**: delivery",
      "",
      "Plans:",
      "- [ ] 2-01: ship",
      "",
    ].join("\n"),
  );
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "done\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "99-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-01-PLAN.md"),
    "---\nphase: 2\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress --next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd verify-work 1"',
  );
});

test("gsd progress --next ignores noncanonical verification artifacts before blocking route", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "phases", "2-delivery"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
  );
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 1-01\nstatus: Ready to execute\n",
  );
  writeFileSync(
    join(cwd, ".planning", "ROADMAP.md"),
    [
      "### Phase 1: Foundation",
      "",
      "**Goal**: foundation",
      "",
      "Plans:",
      "- [ ] 1-01: build",
      "",
      "### Phase 2: Delivery",
      "",
      "**Goal**: delivery",
      "",
      "Plans:",
      "- [ ] 2-01: ship",
      "",
    ].join("\n"),
  );
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "done\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-VERIFICATION.md"),
    "---\nstatus: passed\n---\n\n# Verification\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "99-VERIFICATION.md"),
    "---\nstatus: human_needed\n---\n\n# Verification\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-01-PLAN.md"),
    "---\nphase: 2\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("progress --next", createCommandContext(cwd, notifications, fakePi));

  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd verify-work 1"',
  );
});

test("gsd next routes completed phase to verify-work workflow", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "phases", "2-delivery", "2-01-SUMMARY.md"), "summary\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd verify-work 2"',
  );
});

test("gsd next ignores malformed summary ids before verify-work routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "phases", "2-delivery"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
  );
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 1-01\nstatus: Ready to execute\n",
  );
  writeFileSync(
    join(cwd, ".planning", "ROADMAP.md"),
    [
      "### Phase 1: Foundation",
      "",
      "**Goal**: foundation",
      "",
      "Plans:",
      "- [ ] 1-01: build",
      "",
      "### Phase 2: Delivery",
      "",
      "**Goal**: delivery",
      "",
      "Plans:",
      "- [ ] 2-01: ship",
      "",
    ].join("\n"),
  );
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-extra-SUMMARY.md"), "junk\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-01-PLAN.md"),
    "---\nphase: 2\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 1"',
  );
});

test("gsd next ignores noncanonical UAT artifacts before later-phase routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  mkdirSync(join(cwd, ".planning", "phases", "2-delivery"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
  );
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 1-01\nstatus: Ready to execute\n",
  );
  writeFileSync(
    join(cwd, ".planning", "ROADMAP.md"),
    [
      "### Phase 1: Foundation",
      "",
      "**Goal**: foundation",
      "",
      "Plans:",
      "- [ ] 1-01: build",
      "",
      "### Phase 2: Delivery",
      "",
      "**Goal**: delivery",
      "",
      "Plans:",
      "- [ ] 2-01: ship",
      "",
    ].join("\n"),
  );
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "done\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "99-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-01-PLAN.md"),
    "---\nphase: 2\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd verify-work 1"',
  );
});

test("gsd next fails closed when roadmap has no phases", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, ".planning", "phases"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "config.json"),
    '{"model_profile":"balanced","commit_docs":true,"parallelization":true,"search_gitignored":false,"brave_search":false,"firecrawl":false,"exa_search":false}\n',
  );
  writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# Roadmap\n\nNo phases yet.\n");
  writeFileSync(join(cwd, ".planning", "PROJECT.md"), "# Project\n");
  writeFileSync(join(cwd, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(join(cwd, ".planning", "STATE.md"), "status: Ready to plan\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next no roadmap phases",
    level: "warning",
  });
});

test("gsd next keeps incomplete UAT routing on verify-work workflow", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "phases", "2-delivery", "2-01-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-UAT.md"),
    [
      "---",
      "status: partial",
      "phase: 2-delivery",
      "source: 2-01-SUMMARY.md",
      "started: 2026-05-08T00:00:00Z",
      "updated: 2026-05-08T00:00:00Z",
      "---",
      "",
      "## Current Test",
      "",
      "number: 1",
      "name: Demo",
      "expected: |",
      "ok",
      "awaiting: user response",
      "",
      "## Tests",
      "",
      "### 1. Demo",
      "",
      "expected: ok",
      "result: [pending]",
      "",
      "## Summary",
      "",
      "total: 1",
      "passed: 0",
      "issues: 0",
      "pending: 1",
      "skipped: 0",
      "blocked: 0",
      "",
      "## Gaps",
      "",
    ].join("\n"),
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd verify-work 2"',
  );
});

test("gsd next routes finished roadmap to complete-milestone workflow", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "summary\n");
  writeFileSync(join(cwd, ".planning", "phases", "2-delivery", "2-01-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-01-VERIFICATION.md"),
    "verification\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next --force", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd complete-milestone"',
  );
});

test("gsd next blocks error state unless forced", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: \nstatus: Blocked by review\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by status: Blocked by review. Re-run with /gsd next --force to bypass.",
    level: "warning",
  });
  await command?.handler("next --force", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 2"',
  );
});

test("gsd next fails closed without workflow session instead of mutating state", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const before = await readFile(join(cwd, ".planning", "STATE.md"), "utf8");
  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await command?.handler("next", noSessionContext);

  const after = await readFile(join(cwd, ".planning", "STATE.md"), "utf8");
  expect(after).toBe(before);
  expect(notifications.at(-1)).toEqual({
    message:
      "Next requires workflow session for /gsd execute-phase 2. Cannot safely fall back to pointer-only state updates.",
    level: "warning",
  });
});

test("gsd next fails closed without workflow session for verify-work route", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "phases", "2-delivery", "2-01-SUMMARY.md"), "summary\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await command?.handler("next", noSessionContext);

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message:
      "Next requires workflow session for /gsd verify-work 2. Cannot safely fall back to pointer-only state updates.",
    level: "warning",
  });
});

test("gsd next fails closed without workflow session for complete-milestone route", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-01-PLAN.md"),
    "---\nphase: 1\nplan: 01\ntype: build\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: []\n---\n",
  );
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "summary\n");
  writeFileSync(join(cwd, ".planning", "phases", "2-delivery", "2-01-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-01-VERIFICATION.md"),
    "verification\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  writeFileSync(
    join(cwd, ".planning", "phases", "2-delivery", "2-UAT.md"),
    "---\nstatus: complete\n---\n\n# UAT\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await command?.handler("next --force", noSessionContext);

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message:
      "Next requires workflow session for /gsd complete-milestone. Cannot safely fall back to pointer-only state updates.",
    level: "warning",
  });
});

test("gsd next can route discuss-phase without workflow session", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  rmSync(join(cwd, ".planning", "phases", "2-delivery"), { recursive: true, force: true });
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await command?.handler("next", noSessionContext);

  expect(
    notifications.some((item) => item.message.includes("Next requires workflow session")),
  ).toBe(false);
  expect(notifications.at(-1)).toEqual({
    message:
      "Existing context for phase 2\n\nOptions:\n- Use existing context\n- View context summary\n- Skip prior context",
    level: "info",
  });
});

test("gsd next can route plan-phase without workflow session", async () => {
  const fakePi = new FakePi();
  const spawn = vi.fn(async (request: { name?: string; outputFormat?: { type: string } }) => {
    if (request.outputFormat?.type === "json_schema") {
      if (request.name === "gsd-planner") {
        return {
          ok: true,
          value: {
            structured: {
              status: "created",
              summary: "created",
            },
          },
        };
      }

      return {
        ok: true,
        value: {
          structured: {
            approved: true,
            summary: "approved",
            issues: [],
          },
        },
      };
    }

    const planPath = join(cwd, ".planning", "phases", "2-delivery", "02-01-PLAN.md");
    if (!existsSync(planPath)) {
      writeFileSync(
        planPath,
        [
          "---",
          "phase: 02",
          "plan: 01",
          "type: build",
          "wave: 1",
          "depends_on: []",
          "files_modified: []",
          "autonomous: true",
          "must_haves: [ship]",
          "---",
          "",
          "# Plan",
          "",
          "## Tasks",
          "",
          "### Task 1: Ship",
          "",
          "Do work.",
        ].join("\n"),
      );
    }

    return {
      ok: true,
      value: {
        handle: {
          sessionId: "stub-session",
          async waitForCompletion() {
            return { sessionId: "stub-session", status: "completed", summary: "ok" };
          },
          async captureOutput() {
            return { text: "", truncated: false };
          },
        },
      },
    };
  });
  setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  rmSync(join(cwd, ".planning", "phases", "2-delivery", "2-01-PLAN.md"), { force: true });
  writeFileSync(join(cwd, ".planning", "phases", "2-delivery", "2-CONTEXT.md"), "# Context\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const noSessionContext = {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  await command?.handler("next", noSessionContext);

  expect(
    notifications.some((item) => item.message.includes("Next requires workflow session")),
  ).toBe(false);
  expect(spawn).toHaveBeenCalled();
});

test("gsd next blocks paused checkpoint markers before routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", ".continue-here.md"),
    [
      "# Resume",
      "",
      "| Requirement | Status | Blocking Issue |",
      "| --- | --- | --- |",
      "| Delivery | pending | waiting on user checkpoint |",
    ].join("\n"),
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by .continue-here.md; resume pending work before /gsd next",
    level: "warning",
  });
});

test("gsd next force still blocks discuss checkpoints before routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "DISCUSS-CHECKPOINT.json"),
    JSON.stringify({ phase: "1" }),
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("next --force", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by discuss checkpoint in phase 1; resume with /gsd discuss-phase 1",
    level: "warning",
  });
});

test("gsd next force still blocks paused checkpoint markers before routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", ".continue-here.md"),
    [
      "# Resume",
      "",
      "| Requirement | Status | Blocking Issue |",
      "| --- | --- | --- |",
      "| Delivery | pending | waiting on user checkpoint |",
    ].join("\n"),
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("next --force", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by .continue-here.md; resume pending work before /gsd next",
    level: "warning",
  });
});

test("gsd next blocks paused state before routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 01-01\nstatus: Paused for review\npaused_at: 2026-05-08T12:00:00Z\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("next", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by paused state at 2026-05-08T12:00:00Z",
    level: "warning",
  });
});

test("gsd next force still blocks paused state before routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(
    join(cwd, ".planning", "STATE.md"),
    "milestone: v1.0\ncurrent_phase: 1\ncurrent_phase_name: Foundation\ncurrent_plan: 01-01\nstatus: Paused for review\npaused_at: 2026-05-08T12:00:00Z\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("next --force", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by paused state at 2026-05-08T12:00:00Z",
    level: "warning",
  });
});

test("gsd next force still blocks unresolved verification fail before routing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  writeFileSync(join(cwd, ".planning", "phases", "1-foundation", "1-01-SUMMARY.md"), "summary\n");
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "1-VERIFICATION.md"),
    "---\nverified: false\n---\n\n# Verification\n",
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("next --force", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Next blocked by unresolved verification FAIL in phase 1; rerun /gsd verify-work 1",
    level: "warning",
  });
});

test("gsd dashboard fallback reports pending todo count", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message: "GSD enabled=true progress=50% phase=2 goals=2 milestones=1 todos=1",
    level: "info",
  });
});

test("gsd rejects unknown subcommands instead of falling through to dashboard", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("retro", createCommandContext(cwd, notifications));

  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd command: retro. Run /gsd help.",
    level: "warning",
  });
});

test("gsd help in non-ui mode emits durable command output instead of notification", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("help", createCommandContext(cwd, notifications));

  expect(notifications).toEqual([]);
  expect(fakePi.sendMessage).toHaveBeenCalledTimes(1);
  expect(fakePi.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      customType: "gsd-help",
      display: true,
      content: expect.stringContaining("# GSD Command Reference"),
    }),
    { triggerTurn: false },
  );
});

test("gsd help content mentions enablement gate and local-only guardrails", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("help", createCommandContext(cwd, notifications));

  const content = String(fakePi.sendMessage.mock.calls[0]?.[0]?.content ?? "");
  expect(content).toContain(
    "Start new local planning tree with `/gsd new-project [brief]`, or run `/gsd on` if planning already exists.",
  );
  expect(content).toContain("## Upstream Crosswalk");
  expect(content).toContain(
    "Upstream `/gsd phase` does not exist here as one grouped command. Use local `/gsd discuss-phase`, `/gsd plan-phase`, `/gsd execute-phase`, `/gsd verify-work`, `/gsd secure-phase`, `/gsd validate-phase`.",
  );
  expect(content).toContain("## Unsupported Upstream Commands");
  expect(content).toContain(
    "If upstream docs mention `/gsd <name>` command not listed below, command is unavailable in this repo.",
  );
  expect(content).toContain(
    "Common unavailable examples: `/gsd retro`, `/gsd phase`, `/gsd project`, `/gsd milestone`, `/gsd map`.",
  );
  expect(content).toContain("Local-only command surface. Only commands below supported here.");
  expect(content).toContain(
    "Non-UI `/gsd help` emits durable `gsd-help` message output; registered local renderer is intended handling path.",
  );
  expect(content).toContain(
    "Some commands reject unsupported local flags explicitly; others still accept extra tokens or freeform input.",
  );
  expect(content).toContain("Not claim upstream parity.");
  expect(content).toContain("/gsd new-project --auto @idea.md");
  expect(content).toContain(
    "`--tokens-used` and `--context-window` require `--context`; `--repair` and `--context` cannot be combined in one run",
  );
  expect(content).toContain(
    "shows active local GSD subagent/session status in UI panel or plain text",
  );
  expect(content).toContain(
    "use when you want current local GSD worker activity, not upstream/global service health",
  );
  expect(content).toContain(
    "fails closed when workflow session support is unavailable in current context",
  );
  expect(content).toContain(
    "variants: `json`, `table`, `--json`, `--table`, `--format json`, `--format table`",
  );
  expect(content).toContain(
    "`--force` only bypasses blocked/error `STATE.md` status gate; `.continue-here.md`, paused state, discuss checkpoints, and unresolved verification FAIL still stop routing",
  );
  expect(content).toContain(
    "fails closed when `.planning/PROJECT.md`, `.planning/ROADMAP.md`, or `.planning/STATE.md` is missing",
  );
  expect(content).toContain(
    "`progress --next` inherits `/gsd next` routing; local `discuss-phase` and `plan-phase` routes still work without workflow session support, while workflow-native routes fail closed",
  );
  expect(content).toContain(
    "config-disabled Nyquist validation, ambiguous/non-canonical VALIDATION inventory, malformed helper payloads, helper execution failures, and helper target paths outside the exact canonical phase `*-VALIDATION.md` fail closed before workflow launch",
  );
  expect(content).toContain(
    "local fast mode only supports `--fast refresh`; `--fast update` and `--fast skip` fail explicitly",
  );
});

test("gsd stats json and table route to structured local outputs", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("stats json", createCommandContext(cwd, notifications));
  expect(JSON.parse(notifications.at(-1)?.message ?? "")).toMatchObject({
    phases_total: 2,
    total_plans: 2,
  });

  await command?.handler("stats table", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual(
    expect.objectContaining({
      level: "info",
      message: expect.stringContaining("| Phase | Name | Plans | Completed | Status |"),
    }),
  );
});

test("gsd stats rejects unsupported variants explicitly", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("stats yaml", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd stats argument: yaml.",
    level: "warning",
  });
});

test("gsd new-project bootstraps and launches workflow through grouped command", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  const context = createCommandContext(cwd, notifications, fakePi);
  await command?.handler("new-project", context);
  const roadmap = await readFile(join(cwd, ".planning", "ROADMAP.md"), "utf8");
  expect(roadmap).toContain("No phases yet.");
  expect(readRoadmapPhases(cwd)).toEqual([]);
  expect(notifications.at(-1)).toEqual({
    message: `GSD initialized bootstrap in ${join(cwd, ".planning")}`,
    level: "info",
  });
  expect(context.fork).not.toHaveBeenCalled();
  expect(context.newSession).not.toHaveBeenCalled();
  expect(String(fakePi.sendUserMessage.mock.calls[0]?.[0])).toContain(
    'Launch native GSD workflow for "/gsd new-project"',
  );
  expect(String(fakePi.sendUserMessage.mock.calls[0]?.[0])).toContain(resolveInstructionFileName());
  expect(String(fakePi.sendUserMessage.mock.calls[0]?.[0])).toContain(
    "Init metadata: IS_BROWNFIELD=false",
  );
  expect(String(fakePi.sendUserMessage.mock.calls[0]?.[0])).toContain(
    "Preflight already completed by local handler before this steer prompt",
  );
  expect(existsSync(join(cwd, ".git"))).toBe(true);
});

test("gsd new-project grouped command includes brownfield metadata for existing repo", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "index.ts"), "export const repo = true;\n");
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");

  await command?.handler("new-project", createCommandContext(cwd, notifications, fakePi));

  const prompt = String(fakePi.sendUserMessage.mock.calls[0]?.[0]);
  expect(prompt).toContain("Init metadata: IS_BROWNFIELD=true");
  expect(prompt).toContain("Init metadata: NEEDS_CODEBASE_MAP=true");
});

test("gsd new-project preserves raw auto arguments through grouped command", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler(
    "new-project --auto @idea.md",
    createCommandContext(cwd, notifications, fakePi),
  );
  expect(String(fakePi.sendUserMessage.mock.calls[0]?.[0])).toContain(
    'Launch native GSD workflow for "/gsd new-project --auto @idea.md"',
  );
});

test("gsd execute-phase launches workflow foundation with raw args and bundled resources", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler(
    "execute-phase 2 --wave 1 --gaps-only --interactive --validate",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).toHaveBeenCalledTimes(1);
  const prompt = String(fakePi.sendUserMessage.mock.calls[0]?.[0]);
  expect(prompt).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 2 --wave 1 --gaps-only --interactive --validate"',
  );
  expect(prompt).toContain("Command arguments: 2 --wave 1 --gaps-only --interactive --validate");
  expect(prompt).toContain(resolveGsdBundlePath("commands/gsd/execute-phase.md"));
  expect(prompt).toContain(resolveGsdBundlePath("workflows/execute-phase.md"));
  expect(prompt).toContain(
    resolveGsdBundlePath("workflows/execute-phase/steps/per-plan-worktree-gate.md"),
  );
  expect(prompt).toContain(
    resolveGsdBundlePath("workflows/execute-phase/steps/post-merge-gate.md"),
  );
  expect(prompt).toContain(
    resolveGsdBundlePath("workflows/execute-phase/steps/codebase-drift-gate.md"),
  );
  expect(prompt).toContain(resolveGsdBundlePath("references/agent-contracts.md"));
  expect(prompt).toContain(resolveGsdBundlePath("references/context-budget.md"));
  expect(prompt).toContain(resolveGsdBundlePath("references/worktree-path-safety.md"));
  expect(prompt).toContain(`Runtime contract: GSD_BUNDLE_DIR=${resolveGsdBundlePath()}`);
  expect(prompt).toContain(
    `Runtime contract: GSD_TOOLS_PATH=${resolveGsdBundlePath("bin", "gsd-tools.cjs")}`,
  );
  expect(prompt).toContain(
    "`--wave` filter activates for both `--wave <N>` and `--wave=<N>` raw-arg forms",
  );
  expect(prompt).not.toContain("cross-AI");
  expect(prompt).toContain("Do not call local native `orchestrateExecutePhase()` path");
});

test("gsd execute-phase preserves --wave=<N> semantics through workflow launch", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler(
    "execute-phase --wave=3 4",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).toHaveBeenCalledTimes(1);
  const prompt = String(fakePi.sendUserMessage.mock.calls[0]?.[0]);
  expect(prompt).toContain('Launch native GSD workflow for "/gsd execute-phase --wave=3 4"');
  expect(prompt).toContain("Command arguments: --wave=3 4");
  expect(prompt).toContain(
    "`--wave` filter activates for both `--wave <N>` and `--wave=<N>` raw-arg forms",
  );
});

test("gsd execute-phase preserves workflow-native passthrough flags before workflow launch", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler(
    "execute-phase 2 --cross-ai --no-cross-ai --auto --mvp --tdd",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).toHaveBeenCalledTimes(1);
  const prompt = String(fakePi.sendUserMessage.mock.calls[0]?.[0]);
  expect(prompt).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 2 --cross-ai --no-cross-ai --auto --mvp --tdd"',
  );
  expect(prompt).toContain("Command arguments: 2 --cross-ai --no-cross-ai --auto --mvp --tdd");
});

test("gsd verify-work rejects unsupported args before workflow launch", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("verify-work 1 junk", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd verify-work extra positional argument: junk.",
    level: "warning",
  });
});

test("gsd secure-phase launches workflow resources", async () => {
  const cwd = createTempDirSync("agent-gsd-secure-");
  const notifications: Array<{ message: string; level: string }> = [];
  const fakePi = new FakePi();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("secure-phase 1", createCommandContext(cwd, notifications, fakePi));
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd secure-phase 1"',
  );
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    resolveGsdBundlePath("commands/gsd/secure-phase.md"),
  );
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    resolveGsdBundlePath("workflows/secure-phase.md"),
  );
});

test("gsd secure-phase rejects malformed and unsupported args explicitly", async () => {
  const cwd = createTempDirSync("agent-gsd-secure-args-");
  const notifications: Array<{ message: string; level: string }> = [];
  const fakePi = new FakePi();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("secure-phase --phase", createCommandContext(cwd, notifications, fakePi));
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd secure-phase flag: --phase requires a value.",
    level: "warning",
  });

  await command?.handler("secure-phase --bogus", createCommandContext(cwd, notifications, fakePi));
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd secure-phase flag: --bogus.",
    level: "warning",
  });

  await command?.handler("secure-phase 1 junk", createCommandContext(cwd, notifications, fakePi));
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd secure-phase extra positional argument: junk.",
    level: "warning",
  });
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
});

test("gsd execute-phase requires explicit phase before workflow launch", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("execute-phase", createCommandContext(cwd, notifications, fakePi));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "/gsd execute-phase requires explicit phase in Slice 1 foundation.",
    level: "warning",
  });
});

test("gsd validate-phase rejects malformed phase flag explicitly", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler("validate-phase --phase", createCommandContext(cwd, notifications));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd validate-phase flag: --phase requires a value.",
    level: "warning",
  });

  await command?.handler("validate-phase --phase=", createCommandContext(cwd, notifications));

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd validate-phase flag: --phase requires a value.",
    level: "warning",
  });
});

test("gsd execute-phase rejects extra positional tokens before workflow launch", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler(
    "execute-phase --phase 2 3",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd execute-phase extra positional argument: 3.",
    level: "warning",
  });
});

test("gsd execute-phase rejects non-numeric wave before workflow launch", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  await command?.handler(
    "execute-phase 2 --wave nope",
    createCommandContext(cwd, notifications, fakePi),
  );

  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "Unsupported /gsd execute-phase flag: --wave requires positive integer value.",
    level: "warning",
  });
});

test("gsd new-project rejects auto mode without source material", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("new-project --auto", createCommandContext(cwd, notifications, fakePi));
  expect(fakePi.sendUserMessage).not.toHaveBeenCalled();
  expect(notifications.at(-1)).toEqual({
    message: "/gsd new-project --auto requires idea text or @file input.",
    level: "warning",
  });
});

test("gsd new-project reruns when only placeholder bootstrap exists", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  const firstContext = createCommandContext(cwd, notifications, fakePi);
  await command?.handler("new-project", firstContext);
  const secondContext = createCommandContext(cwd, notifications, fakePi);
  await command?.handler("new-project", secondContext);
  expect(fakePi.sendUserMessage).toHaveBeenCalledTimes(2);
  expect(
    notifications.some((entry) => entry.message === "GSD already initialized. Run /gsd progress."),
  ).toBe(false);
});

test("gsd new-milestone and milestone-summary route through grouped command surface", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  const context = createCommandContext(cwd, notifications, fakePi);
  await command?.handler("on", context);
  await command?.handler("new-milestone v1.1 Notifications", context);
  await command?.handler("milestone-summary v1.1", context);
  expect(fakePi.sendUserMessage).toHaveBeenCalled();
  const prompts = fakePi.sendUserMessage.mock.calls.map((call) => call[0]);
  expect(
    prompts.some((prompt) =>
      String(prompt).includes(
        'Launch native GSD workflow for "/gsd new-milestone v1.1 Notifications"',
      ),
    ),
  ).toBe(true);
  expect(
    prompts.some((prompt) =>
      String(prompt).includes('Launch native GSD workflow for "/gsd milestone-summary v1.1"'),
    ),
  ).toBe(true);
});

test("gsd debug grouped command launches workflow prompt in forked session", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  const context = createCommandContext(cwd, notifications, fakePi);
  await command?.handler("on", context);
  await command?.handler("debug login fails on mobile safari", context);
  expect(fakePi.sendUserMessage).toHaveBeenCalledTimes(1);
  expect(String(fakePi.sendUserMessage.mock.calls[0]?.[0])).toContain(
    "Start `/gsd debug` in this visible workflow session.",
  );
});

test("gsd debug without description launches workflow prompt instead of crashing", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  const context = createCommandContext(cwd, notifications, fakePi);
  await command?.handler("on", context);
  await command?.handler("debug", context);
  expect(String(fakePi.sendUserMessage.mock.calls[0]?.[0])).toContain(
    "Start `/gsd debug` in this visible workflow session.",
  );
  expect(String(fakePi.sendUserMessage.mock.calls[0]?.[0])).toContain(
    "Use `interview` first for symptom intake in this visible workflow session before creating any debug file or spawning `gsd-debugger`.",
  );
});

test("gsd command runs lifecycle flow through grouped command surface", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  const spawn = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      value: {
        handle: {
          waitForCompletion: vi.fn().mockImplementation(async () => {
            mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
            writeFileSync(
              join(cwd, ".planning", "phases", "1-foundation", "01-RESEARCH.md"),
              "# Research\n",
            );
            return {
              sessionId: "research-session-id",
              status: "completed",
              summary: "research complete",
            };
          }),
          captureOutput: vi.fn().mockResolvedValue({ text: "research output" }),
        },
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        handle: {
          waitForCompletion: vi.fn().mockImplementation(async () => {
            writeFileSync(
              join(cwd, ".planning", "phases", "1-foundation", "01-PATTERNS.md"),
              "# Patterns\n",
            );
            return {
              sessionId: "pattern-session-id",
              status: "completed",
              summary: "pattern complete",
            };
          }),
          captureOutput: vi.fn().mockResolvedValue({ text: "pattern output" }),
        },
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        structured: {
          status: "created",
          summary: "plan created",
        },
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        structured: {
          approved: true,
          summary: "approved",
          issues: [],
        },
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        structured: {
          verified: true,
          summary: "phase verified",
          truths: [{ truth: "ship", status: "verified", evidence: "tests pass" }],
          blockers: [],
          warnings: [],
          uat_items: [{ name: "smoke", result: "pass" }],
        },
      },
    });
  setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  mkdirSync(join(cwd, ".planning", "phases", "1-foundation"), { recursive: true });
  writeFileSync(
    join(cwd, ".planning", "phases", "1-foundation", "01-01-PLAN.md"),
    "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/feature.ts]\nautonomous: true\nmust_haves: [feature works]\n---\n\n## Tasks\n\n### Task 1: Implement feature\n\nBuild feature\n",
  );
  await command?.handler("plan-phase 1", createCommandContext(cwd, notifications));
  await command?.handler("execute-phase 1", createCommandContext(cwd, notifications, fakePi));
  await command?.handler("verify-work 1", createCommandContext(cwd, notifications, fakePi));
  expect(
    await readFile(join(cwd, ".planning", "phases", "1-foundation", "01-01-PLAN.md"), "utf8"),
  ).toContain("Implement feature");
  expect(
    await readFile(join(cwd, ".planning", "phases", "1-foundation", "01-PLAN-CHECK.md"), "utf8"),
  ).toContain("approved: true");
  expect(
    notifications.some((entry) => entry.message.includes("Planned 1 plan(s); check approved")),
  ).toBe(true);
  expect(String(fakePi.sendUserMessage.mock.calls.at(-2)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd execute-phase 1"',
  );
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    'Launch native GSD workflow for "/gsd verify-work 1"',
  );
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    resolveGsdBundlePath("commands/gsd/verify-work.md"),
  );
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    resolveGsdBundlePath("workflows/verify-work.md"),
  );
  expect(String(fakePi.sendUserMessage.mock.calls.at(-1)?.[0])).toContain(
    "Do not call local native `orchestrateVerifyWork()` path",
  );
});
