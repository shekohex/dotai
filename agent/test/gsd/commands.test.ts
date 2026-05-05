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

afterEach(() => {
  setGsdSubagentSdkFactoryForTests(undefined);
});

function createCommandContext(
  cwd: string,
  notifications: Array<{ message: string; level: string }>,
) {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
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
        value: "2",
        label: "2 Delivery",
        description: expect.stringContaining("open"),
      }),
      expect.objectContaining({
        value: "--phase",
        label: "--phase",
      }),
      expect.objectContaining({
        value: "--phase=",
        label: "--phase=",
      }),
    ]),
  );

  const phaseFlagItems = await command?.getArgumentCompletions?.("execute-phase --phase ");
  expect(phaseFlagItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "1", label: "1 Foundation" }),
      expect.objectContaining({ value: "2", label: "2 Delivery" }),
    ]),
  );

  const phaseEqualsItems = await command?.getArgumentCompletions?.("execute-phase --phase=");
  expect(phaseEqualsItems).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ value: "--phase=1", label: "1 Foundation" }),
      expect.objectContaining({ value: "--phase=2", label: "2 Delivery" }),
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
