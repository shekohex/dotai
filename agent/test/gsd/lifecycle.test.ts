import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { readRoadmapPhases } from "../../src/extensions/gsd/state/roadmap.js";
import { handleGsdDiscussPhase } from "../../src/extensions/gsd/lifecycle/discuss-phase.js";
import { handleGsdDebug } from "../../src/extensions/gsd/lifecycle/debug.js";
import { handleGsdMapCodebase } from "../../src/extensions/gsd/lifecycle/map-codebase.js";
import { handleGsdCompleteMilestone } from "../../src/extensions/gsd/lifecycle/complete-milestone.js";
import { handleGsdMilestoneSummary } from "../../src/extensions/gsd/lifecycle/milestone-summary.js";
import { handleGsdNewMilestone } from "../../src/extensions/gsd/lifecycle/new-milestone.js";
import { handleGsdNewProject } from "../../src/extensions/gsd/lifecycle/new-project.js";
import { handleGsdValidatePhase } from "../../src/extensions/gsd/lifecycle/validate-phase.js";
import { handleGsdVerifyWork } from "../../src/extensions/gsd/lifecycle/verify-work.js";
import { setGsdSubagentSdkFactoryForTests } from "../../src/extensions/gsd/subagents.js";
import { applyPendingGsdWorkflowLaunch } from "../../src/extensions/gsd/workflow-launch.js";

function createRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-gsd-lifecycle-"));
}

function createPlanningRoot(): string {
  const root = createRoot();
  mkdirSync(join(root, ".planning", "phases"), { recursive: true });
  writeFileSync(
    join(root, ".planning", "config.json"),
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
    join(root, ".planning", "ROADMAP.md"),
    `# Roadmap: Demo

### Phase 1: Setup
**Goal**: Establish project baseline

Plans:
- [ ] 01-01: Create config

### Phase 2: Build
**Goal**: Ship feature

Plans:
- [ ] 02-01: Implement feature
`,
  );
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: \nstatus: Ready to plan\n",
  );
  return root;
}

function createContext(cwd: string, pi?: ExtensionAPI): ExtensionCommandContext {
  const modelRegistry = {
    find(provider: string, id: string) {
      return { provider, id };
    },
  };

  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
    },
    sessionManager: {
      getSessionId: () => "parent-session-id",
      getLeafId: () => "leaf-id",
      getSessionFile: () => join(cwd, ".pi", "session.jsonl"),
    },
    modelRegistry,
    fork: vi.fn(
      async (_entryId: string, options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
        if (pi) {
          await applyPendingGsdWorkflowLaunch(
            pi,
            {
              cwd,
              hasUI: false,
              ui: { notify: vi.fn() },
              modelRegistry,
            } as unknown as ExtensionCommandContext,
            "fork",
          );
          await options?.withSession?.({
            cwd,
            hasUI: false,
            ui: { notify: vi.fn() },
            modelRegistry,
            sendUserMessage: pi.sendUserMessage,
          });
        }
        return { cancelled: false };
      },
    ),
    newSession: vi.fn(async (options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
      if (pi) {
        await applyPendingGsdWorkflowLaunch(
          pi,
          {
            cwd,
            hasUI: false,
            ui: { notify: vi.fn() },
            modelRegistry,
          } as unknown as ExtensionCommandContext,
          "new",
        );
        await options?.withSession?.({
          cwd,
          hasUI: false,
          ui: { notify: vi.fn() },
          modelRegistry,
          sendUserMessage: pi.sendUserMessage,
        });
      }
      return { cancelled: false };
    }),
  } as unknown as ExtensionCommandContext;
}

function createPi() {
  return {
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
}

afterEach(() => {
  setGsdSubagentSdkFactoryForTests(undefined);
});

describe("gsd lifecycle handlers", () => {
  it("new-project writes baseline planning files", () => {
    const root = createRoot();
    const ctx = createContext(root);
    handleGsdNewProject({} as ExtensionAPI, ctx);
    expect(readFileSync(join(root, ".planning", "config.json"), "utf8")).toContain(
      '"model_profile": "balanced"',
    );
    expect(readFileSync(join(root, ".planning", "PROJECT.md"), "utf8")).toContain(
      root.split("/").at(-1) ?? "",
    );
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Ready to plan",
    );
  });

  it("new-project does not seed placeholder roadmap phases", () => {
    const root = createRoot();
    const ctx = createContext(root);
    handleGsdNewProject({} as ExtensionAPI, ctx);
    expect(readRoadmapPhases(root)).toEqual([]);
  });

  it("map-codebase spawns direct-write mapper roles for all focus areas", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const pi = createPi() as ExtensionAPI & { sendMessage: ReturnType<typeof vi.fn> };
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "Mapping Complete",
          }),
          captureOutput: vi.fn().mockResolvedValue({ text: "## Mapping Complete\nReady" }),
        },
      },
    });
    const sdkFactory = vi.fn().mockReturnValue({ spawn });
    setGsdSubagentSdkFactoryForTests(sdkFactory as never);
    await handleGsdMapCodebase(pi, ctx);
    expect(sdkFactory).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(readFileSync(join(root, ".planning", "ROADMAP.md"), "utf8")).toContain("Phase 1");
    expect(spawn.mock.calls.map((call) => call[0]?.completion)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(spawn.mock.calls.map((call) => call[0]?.name)).toEqual([
      "codebase-mapper:tech",
      "codebase-mapper:arch",
      "codebase-mapper:quality",
      "codebase-mapper:concerns",
    ]);
    expect(spawn.mock.calls.map((call) => call[0]?.task)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Focus: tech"),
        expect.stringContaining("Focus: arch"),
        expect.stringContaining("Focus: quality"),
        expect.stringContaining("Focus: concerns"),
      ]),
    );
    expect(spawn.mock.calls[0]?.[0]?.task).toContain("<required_reading>");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(".planning/PROJECT.md");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(
      "Write these documents to .planning/codebase/",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith("Started codebase map: 4 subagents", "info");
    await vi.waitFor(() => {
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(pi.sendMessage.mock.calls[0]?.[1]).toEqual({ deliverAs: "steer", triggerTurn: false });
    expect(pi.sendMessage.mock.calls[0]?.[0]?.content).toContain("Codebase mapping complete.");
    expect(pi.sendMessage.mock.calls[0]?.[0]?.details?.areas).toHaveLength(4);
  });

  it("map-codebase passes validated --paths scope to each mapper role", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "Mapping Complete",
          }),
          captureOutput: vi.fn().mockResolvedValue({ text: "## Mapping Complete\nReady" }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      paths: ["src", "packages/ui", "../bad", "apps/$oops"],
    });

    expect(spawn).toHaveBeenCalledTimes(4);
    for (const call of spawn.mock.calls) {
      expect(call[0]?.task).toContain("--paths src,packages/ui");
      expect(call[0]?.task).not.toContain("../bad");
      expect(call[0]?.task).not.toContain("apps/$oops");
    }
  });

  it("discuss-phase writes phase-specific context for explicit phase", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        structured: {
          boundary: "Ship feature",
          decisions: [{ area: "Delivery", choices: ["Use existing service layer"] }],
          discretion: ["Exact function split"],
          specifics: ["Keep API small"],
          references: [{ path: "docs/feature.md", reason: "Requirements" }],
          reusable_assets: ["src/shared/api.ts"],
          patterns: ["Prefer composition"],
          integration_points: ["src/routes.ts"],
          deferred: ["Admin UI"],
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    const contextPath = join(root, ".planning", "phases", "2-build", "02-CONTEXT.md");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain("<required_reading>");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(join(root, ".planning", "ROADMAP.md"));
    expect(readFileSync(contextPath, "utf8")).toContain("# Phase 2: Build - Context");
    expect(readFileSync(contextPath, "utf8")).toContain("Use existing service layer");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "current_phase_name: Build",
    );
  });

  it("validate-phase writes validation file for explicit phase", () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    handleGsdValidatePhase({} as ExtensionAPI, ctx, { phase: "2" });
    const validationPath = join(root, ".planning", "phases", "2-build", "02-VALIDATION.md");
    expect(readFileSync(validationPath, "utf8")).toContain("Validation");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain("current_phase: 2");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Ready to validate",
    );
  });

  it("verify-work writes verification artifacts and updates state", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "1-setup", "01-01-PLAN.md"),
      "---\nphase: 01\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: [src/config.ts]\nautonomous: true\nmust_haves: [works]\n---\n",
    );
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        structured: {
          verified: true,
          summary: "verified",
          truths: [{ truth: "works", status: "verified", evidence: "manual check" }],
          blockers: [],
          warnings: [],
          uat_items: [{ name: "smoke", result: "pass" }],
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdVerifyWork({} as ExtensionAPI, ctx, {});
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-VERIFICATION.md"), "utf8"),
    ).toContain("verified");
    expect(
      readFileSync(join(root, ".planning", "phases", "1-setup", "01-VALIDATION.md"), "utf8"),
    ).toContain("Validated");
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Phase complete",
    );
  });

  it("new-milestone launches workflow prompt in forked session", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdNewMilestone(pi, ctx, { milestone: "v1.1 Notifications" });
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd new-milestone v1.1 Notifications"',
    );
  });

  it("complete-milestone launches workflow prompt in forked session", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdCompleteMilestone(pi, ctx, { version: "v1.0" });
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd complete-milestone v1.0"',
    );
  });

  it("milestone-summary launches workflow prompt in forked session", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdMilestoneSummary(pi, ctx, { version: "v1.0" });
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd milestone-summary v1.0"',
    );
  });

  it("debug launches workflow prompt in forked session", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdDebug(pi, ctx, {
      debugAction: "start",
      description: "login fails on mobile safari",
      diagnose: true,
    });
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "Start `/gsd debug` in this visible workflow session.",
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "Use `interview` first for symptom intake in this visible workflow session before creating any debug file or spawning `gsd-debugger`.",
    );
  });

  it("debug avoids stale ctx access after session replacement", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    let replaced = false;
    const modelRegistry = {
      find(provider: string, id: string) {
        return { provider, id };
      },
    };
    const ctx = {
      get cwd() {
        if (replaced) {
          throw new Error(
            "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
          );
        }
        return root;
      },
      hasUI: false,
      ui: {
        notify: vi.fn(),
      },
      sessionManager: {
        getSessionId: () => "parent-session-id",
        getLeafId: () => "leaf-id",
        getSessionFile: () => join(root, ".pi", "session.jsonl"),
      },
      modelRegistry,
      fork: vi.fn(async () => {
        return { cancelled: false };
      }),
      newSession: vi.fn(async (options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
        await applyPendingGsdWorkflowLaunch(
          pi,
          {
            cwd: root,
            hasUI: false,
            ui: { notify: vi.fn() },
            modelRegistry,
          } as unknown as ExtensionCommandContext,
          "new",
        );
        replaced = true;
        await options?.withSession?.({
          cwd: root,
          hasUI: false,
          ui: { notify: vi.fn() },
          modelRegistry,
          sendUserMessage: pi.sendUserMessage,
        });
        return { cancelled: false };
      }),
    } as unknown as ExtensionCommandContext;

    await expect(
      handleGsdDebug(pi, ctx, { debugAction: "start", description: "parser unstable" }),
    ).resolves.toBeUndefined();
  });

  it("debug without description launches workflow prompt in forked session", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdDebug(pi, ctx, { debugAction: "start" });
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "Start `/gsd debug` in this visible workflow session.",
    );
  });
});
