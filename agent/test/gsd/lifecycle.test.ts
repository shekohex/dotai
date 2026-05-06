import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import {
  handleGsdNewProject,
  resolveInstructionFileName,
} from "../../src/extensions/gsd/lifecycle/new-project.js";
import { handleGsdValidatePhase } from "../../src/extensions/gsd/lifecycle/validate-phase.js";
import { handleGsdVerifyWork } from "../../src/extensions/gsd/lifecycle/verify-work.js";
import { resolveGsdBundlePath } from "../../src/extensions/gsd/resources.js";
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
  writeFileSync(join(root, resolveInstructionFileName()), "project instructions\n");
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
  it("new-project bootstraps planning files and launches workflow prompt", async () => {
    const root = createRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdNewProject(pi, ctx, {}, "");
    expect(readFileSync(join(root, ".planning", "config.json"), "utf8")).toContain(
      '"model_profile": "balanced"',
    );
    expect(readFileSync(join(root, ".planning", "config.json"), "utf8")).toContain(
      '"granularity": "standard"',
    );
    expect(readFileSync(join(root, ".planning", "config.json"), "utf8")).not.toContain(
      '"workflow"',
    );
    expect(readFileSync(join(root, ".planning", "PROJECT.md"), "utf8")).toContain(
      root.split("/").at(-1) ?? "",
    );
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "status: Project initialization in progress",
    );
    expect(ctx.fork).not.toHaveBeenCalled();
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd new-project"',
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      resolveInstructionFileName(),
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      `GSD_TOOLS_PATH=${resolveGsdBundlePath("bin", "gsd-tools.cjs")}`,
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      `INSTRUCTION_FILE_PATH=${join(root, resolveInstructionFileName())}`,
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "AVAILABLE_AGENT_TYPES=gsd-project-researcher,gsd-research-synthesizer,gsd-roadmapper",
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      `Init metadata: PROJECT_NAME=${root.split("/").at(-1) ?? ""}`,
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "Init metadata: IS_BROWNFIELD=false",
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "Init metadata: GIT_WORKTREE_READY=true",
    );
    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  it("new-project injects brownfield init metadata for recovery in existing repo", async () => {
    const root = createRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const live = true;\n");
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdNewProject(pi, ctx, {}, "");

    const prompt = String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(prompt).toContain("Init metadata: IS_BROWNFIELD=true");
    expect(prompt).toContain("Init metadata: HAS_CODEBASE_MAP=false");
    expect(prompt).toContain("Init metadata: NEEDS_CODEBASE_MAP=true");
  });

  it("resolveInstructionFileName only treats explicit Codex runtime as AGENTS target", () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

    delete process.env.CODEX_HOME;
    process.env.PI_CODING_AGENT_DIR = "/tmp/agent-dir";
    expect(resolveInstructionFileName()).toBe("CLAUDE.md");

    process.env.CODEX_HOME = "/tmp/codex-home";
    expect(resolveInstructionFileName()).toBe("AGENTS.md");

    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("new-project does not seed placeholder roadmap phases", async () => {
    const root = createRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdNewProject(pi, ctx, {}, "");
    expect(readRoadmapPhases(root)).toEqual([]);
  });

  it("new-project passes raw auto arguments into workflow launch", async () => {
    const root = createRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdNewProject(pi, ctx, { auto: true, input: "@idea.md" }, "--auto @idea.md");

    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd new-project --auto @idea.md"',
    );
  });

  it("new-project rejects auto mode without source material", async () => {
    const root = createRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdNewProject(pi, ctx, { auto: true }, "--auto");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "/gsd new-project --auto requires idea text or @file input.",
      "warning",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("new-project blocks relaunch when planning already initialized", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdNewProject(pi, ctx, {}, "");

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "GSD already initialized. Run /gsd progress.",
      "warning",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("new-project allows rerun when initialization is still placeholder-only", async () => {
    const root = createRoot();
    const pi = createPi();
    const initialCtx = createContext(root, pi);

    await handleGsdNewProject(pi, initialCtx, {}, "");

    const rerunCtx = createContext(root, pi);
    await handleGsdNewProject(pi, rerunCtx, {}, "");

    expect(rerunCtx.ui.notify).not.toHaveBeenCalledWith(
      "GSD already initialized. Run /gsd progress.",
      "warning",
    );
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("new-project allows rerun after phases exist if initialization still marked in progress", async () => {
    const root = createRoot();
    const pi = createPi();
    const firstCtx = createContext(root, pi);

    await handleGsdNewProject(pi, firstCtx, {}, "");

    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo\n\n### Phase 1: Setup\n**Goal**: Start\n\nPlans:\n- [ ] 01-01: Init\n`,
    );

    const secondCtx = createContext(root, pi);
    await handleGsdNewProject(pi, secondCtx, {}, "");

    expect(secondCtx.ui.notify).not.toHaveBeenCalledWith(
      "GSD already initialized. Run /gsd progress.",
      "warning",
    );
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(2);
  });

  it("new-project preserves real state metadata during recovery rerun", async () => {
    const root = createRoot();
    const pi = createPi();
    const firstCtx = createContext(root, pi);

    await handleGsdNewProject(pi, firstCtx, {}, "");

    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo\n\n### Phase 1: Setup\n**Goal**: Start\n\nPlans:\n- [ ] 01-01: Init\n`,
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: 01-01\nstatus: Project initialization in progress\n",
    );

    const secondCtx = createContext(root, pi);
    await handleGsdNewProject(pi, secondCtx, {}, "");

    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    expect(state).toContain("current_phase_name: Setup");
    expect(state).toContain("current_plan: 01-01");
    expect(state).toContain("status: Project initialization in progress");
  });

  it("new-project does not git-init inside existing parent repo subdir", async () => {
    const repoRoot = createRoot();
    const nested = join(repoRoot, "packages", "demo");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repoRoot, "README.md"), "root\n");
    const pi = createPi();
    const initCtx = createContext(repoRoot, pi);
    await handleGsdNewProject(pi, initCtx, {}, "");
    expect(existsSync(join(repoRoot, ".git"))).toBe(true);

    const nestedPi = createPi();
    const nestedCtx = createContext(nested, nestedPi);
    await handleGsdNewProject(nestedPi, nestedCtx, {}, "");

    expect(existsSync(join(nested, ".git"))).toBe(false);
    expect(existsSync(join(nested, ".planning"))).toBe(true);
    const prompt = String(
      (nestedPi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    );
    expect(prompt).toContain("Init metadata: GIT_WORKTREE_READY=true");
    expect(prompt).toContain(`Init metadata: ENCLOSING_GIT_ROOT_PATH=${repoRoot}`);
  });

  it("new-project warns when accidental nested git repo shadows parent worktree", async () => {
    const repoRoot = createRoot();
    const nested = join(repoRoot, "packages", "demo");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repoRoot, "README.md"), "root\n");
    const rootPi = createPi();
    const rootCtx = createContext(repoRoot, rootPi);
    await handleGsdNewProject(rootPi, rootCtx, {}, "");

    execFileSync("git", ["init"], { cwd: nested, stdio: "ignore" });

    const nestedPi = createPi();
    const nestedCtx = createContext(nested, nestedPi);
    await handleGsdNewProject(nestedPi, nestedCtx, {}, "");

    expect(nestedCtx.ui.notify).toHaveBeenCalledWith(
      "Detected nested git repo inside parent worktree. Current directory may have accidental `.git/`.",
      "warning",
    );
    const prompt = String(
      (nestedPi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    );
    expect(prompt).toContain("Init metadata: HAS_ACCIDENTAL_NESTED_GIT_REPO=true");
    expect(prompt).toContain(`Init metadata: GIT_ROOT_PATH=${nested}`);
    expect(prompt).toContain(`Init metadata: ENCLOSING_GIT_ROOT_PATH=${repoRoot}`);
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
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(".planning/ROADMAP.md");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(".planning/STATE.md");
    expect(spawn.mock.calls[0]?.[0]?.task).not.toContain(".planning/PROJECT.md");
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

  it("map-codebase works before init files exist", async () => {
    const root = createRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const app = true;\n");
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

    await handleGsdMapCodebase({} as ExtensionAPI, ctx);

    expect(spawn.mock.calls[0]?.[0]?.task).toContain("<required_reading>");
    expect(spawn.mock.calls[0]?.[0]?.task).not.toContain(".planning/PROJECT.md");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(
      "Write these documents to .planning/codebase/",
    );
  });

  it("new-project includes existing codebase docs in brownfield required reading", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(join(root, ".planning", "codebase", "STACK.md"), "# Stack\n");
    writeFileSync(join(root, ".planning", "codebase", "ARCHITECTURE.md"), "# Architecture\n");
    writeFileSync(join(root, "package.json"), '{"name":"demo"}\n');
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdNewProject(pi, ctx, {}, "");

    const prompt = String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(prompt).toContain(join(root, ".planning", "codebase", "STACK.md"));
    expect(prompt).toContain(join(root, ".planning", "codebase", "ARCHITECTURE.md"));
    expect(prompt).toContain("Init metadata: HAS_CODEBASE_MAP=true");
    expect(prompt).toContain("Init metadata: CODEBASE_DOCS=");
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
