import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import gsdExtension from "../../src/extensions/gsd/index.ts";
import { parseGsdCommandArgs } from "../../src/extensions/gsd/args.ts";
import { readRoadmapPhases } from "../../src/extensions/gsd/state/roadmap.ts";
import { setGsdSubagentSdkFactoryForTests } from "../../src/extensions/gsd/subagents.ts";

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
  return mkdtempSync(join(tmpdir(), "agent-gsd-command-"));
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
            startedAt: Date.now(),
          },
        ],
      }) as never,
  );
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  expect(command).toBeTruthy();
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("status", createCommandContext(cwd, notifications));
  expect(notifications.at(-1)).toEqual({ message: "gsd-planner: running", level: "info" });
});

test("gsd session_start registers built-in modes without writing project modes file", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  const handlers = fakePi.handlers.get("session_start") ?? [];
  for (const handler of handlers) {
    await handler({}, createCommandContext(cwd, notifications));
  }
  expect(existsSync(join(cwd, ".pi", "modes.json"))).toBe(false);
});

test("parseGsdCommandArgs reads positional and flag phase overrides", () => {
  expect(parseGsdCommandArgs("plan-phase 2")).toEqual({ subcommand: "plan-phase", phase: "2" });
  expect(parseGsdCommandArgs("execute-phase --phase 3.1")).toEqual({
    subcommand: "execute-phase",
    phase: "3.1",
  });
  expect(parseGsdCommandArgs("next --phase=4")).toEqual({ subcommand: "next", phase: "4" });
  expect(parseGsdCommandArgs("map-codebase --paths src,packages/ui")).toEqual({
    subcommand: "map-codebase",
    paths: ["src", "packages/ui"],
  });
  expect(parseGsdCommandArgs("map-codebase --paths=apps/web,packages/api")).toEqual({
    subcommand: "map-codebase",
    paths: ["apps/web", "packages/api"],
  });
  expect(parseGsdCommandArgs("new-milestone v1.1 Notifications")).toEqual({
    subcommand: "new-milestone",
    milestone: "v1.1 Notifications",
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

  const mapCodebaseItems = await command?.getArgumentCompletions?.("map-codebase ");
  expect(mapCodebaseItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "map-codebase --paths",
        label: "--paths",
      }),
      expect.objectContaining({
        value: "map-codebase --paths=",
        label: "--paths=",
      }),
    ]),
  );

  const completeMilestoneItems = await command?.getArgumentCompletions?.("complete-milestone ");
  expect(completeMilestoneItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "complete-milestone v1.0", label: "v1.0" }),
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
});

test("gsd autocomplete shows dynamic subcommand hints", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));

  const rootItems = await command?.getArgumentCompletions?.("");
  expect(rootItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        value: "execute-phase",
        description: expect.stringContaining("exec 1 phase"),
      }),
      expect.objectContaining({
        value: "progress",
        description: expect.stringContaining("%"),
      }),
      expect.objectContaining({
        value: "health",
        description: expect.stringContaining("issues"),
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

test("gsd next uses explicit phase override", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  createPlanningFixture(cwd);
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("on", createCommandContext(cwd, notifications));
  await command?.handler("next --phase 2", createCommandContext(cwd, notifications));
  const state = await readFile(join(cwd, ".planning", "STATE.md"), "utf8");
  expect(state).toContain("current_phase: 2");
  expect(state).toContain("current_phase_name: Delivery");
  expect(state).toContain("current_plan: 2-01");
  expect(notifications.at(-1)).toEqual({ message: "Next phase=2 plan=2-01", level: "info" });
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
    message: "GSD enabled=true progress=0% phase=1 goals=2 milestones=1 todos=1",
    level: "info",
  });
});

test("gsd new-project bootstraps empty roadmap through grouped command", async () => {
  const fakePi = new FakePi();
  const notifications: Array<{ message: string; level: string }> = [];
  const cwd = createTempCwd();
  gsdExtension(fakePi as ExtensionAPI);
  const command = fakePi.commands.get("gsd");
  await command?.handler("new-project", createCommandContext(cwd, notifications));
  const roadmap = await readFile(join(cwd, ".planning", "ROADMAP.md"), "utf8");
  expect(roadmap).toContain("No phases yet.");
  expect(readRoadmapPhases(cwd)).toEqual([]);
  expect(notifications.at(-1)).toEqual({
    message: `GSD initialized in ${join(cwd, ".planning")}`,
    level: "info",
  });
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
        structured: {
          plans: [
            {
              phase: "1",
              plan: "02",
              type: "implementation",
              wave: 1,
              depends_on: ["1-01"],
              files_modified: ["src/feature.ts"],
              autonomous: true,
              must_haves: ["feature works"],
              objective: "Ship feature",
              tasks: [
                {
                  title: "Implement feature",
                  files: ["src/feature.ts"],
                  action: "Build feature",
                  verify: "Run tests",
                  done: "Feature behaves correctly",
                },
              ],
            },
          ],
        },
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        structured: {
          approved: true,
          summary: "approved",
          coverage: [{ requirement: "REQ-01", status: "covered", notes: "mapped" }],
          issues: [],
        },
      },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: {
        handle: {
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "execute-session-id",
            status: "completed",
            summary: "execute complete",
          }),
          captureOutput: vi.fn().mockResolvedValue({ text: "execute output" }),
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
  await command?.handler("plan-phase 1", createCommandContext(cwd, notifications));
  await command?.handler("execute-phase 1", createCommandContext(cwd, notifications));
  await command?.handler("verify-work 1", createCommandContext(cwd, notifications));
  expect(
    await readFile(join(cwd, ".planning", "phases", "1-foundation", "1-02-PLAN.md"), "utf8"),
  ).toContain("Ship feature");
  expect(
    await readFile(join(cwd, ".planning", "phases", "1-foundation", "01-PLAN-CHECK.md"), "utf8"),
  ).toContain("approved: true");
  expect(
    await readFile(join(cwd, ".planning", "phases", "1-foundation", "01-VERIFICATION.md"), "utf8"),
  ).toContain("phase verified");
  expect(
    notifications.some((entry) => entry.message.includes("Planned 1 plan(s); check approved")),
  ).toBe(true);
  expect(
    notifications.some((entry) =>
      entry.message.includes("GSD execute-phase finished: phase verified"),
    ),
  ).toBe(true);
  expect(
    notifications.some((entry) =>
      entry.message.includes("GSD verify-work finished: phase verified"),
    ),
  ).toBe(true);
});
