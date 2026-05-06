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
import { buildFastMapperTask } from "../../src/extensions/gsd/lifecycle/map-codebase-prompts.js";
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

function createMapCodebaseSpawn(root: string) {
  return vi.fn().mockImplementation(async ({ task }: { task?: string }) => {
    const taskText = String(task ?? "");
    const documents: string[] = [];
    if (taskText.includes("Focus: tech")) {
      documents.push("STACK.md", "INTEGRATIONS.md");
    }
    if (taskText.includes("Focus: arch")) {
      documents.push("ARCHITECTURE.md", "STRUCTURE.md");
    }
    if (taskText.includes("Focus: quality")) {
      documents.push("CONVENTIONS.md", "TESTING.md");
    }
    if (taskText.includes("Focus: concerns")) {
      documents.push("CONCERNS.md");
    }
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    for (const document of documents) {
      writeFileSync(
        join(root, ".planning", "codebase", document),
        `# ${document}\n\nDetailed analysis for ${document}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }
    return {
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
    };
  });
}

function createFastMapCodebaseSpawn(root: string) {
  return vi.fn().mockImplementation(async ({ task, name }: { task?: string; name?: string }) => {
    const taskText = String(task ?? "");
    const documents: string[] = [];
    if (taskText.includes("Focus: tech")) {
      documents.push("STACK.md", "INTEGRATIONS.md");
    }
    if (taskText.includes("Focus: arch")) {
      documents.push("ARCHITECTURE.md", "STRUCTURE.md");
    }
    if (taskText.includes("Focus: tech+arch")) {
      documents.push("STACK.md", "INTEGRATIONS.md", "ARCHITECTURE.md", "STRUCTURE.md");
    }
    if (taskText.includes("Focus: quality")) {
      documents.push("CONVENTIONS.md", "TESTING.md");
    }
    if (taskText.includes("Focus: concerns")) {
      documents.push("CONCERNS.md");
    }
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    for (const document of documents) {
      writeFileSync(
        join(root, ".planning", "codebase", document),
        `# ${document}\n\nDetailed analysis for ${document}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }
    return {
      ok: true,
      value: {
        handle: {
          sessionId: name ?? "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: name ?? "session-id",
            status: "completed",
            summary: "Fast Mapping Complete",
          }),
          captureOutput: vi.fn().mockResolvedValue({ text: "## Fast Mapping Complete\nReady" }),
        },
      },
    };
  });
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
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    const ctx = createContext(root);
    const pi = createPi() as ExtensionAPI & { sendMessage: ReturnType<typeof vi.fn> };
    const spawn = createMapCodebaseSpawn(root);
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
    expect(pi.sendMessage.mock.calls[0]?.[0]?.content).toContain(
      "Verified `.planning/codebase/` artifacts:",
    );
    expect(pi.sendMessage.mock.calls[0]?.[0]?.details?.areas).toHaveLength(4);
    const structureDoc = readFileSync(join(root, ".planning", "codebase", "STRUCTURE.md"), "utf8");
    expect(structureDoc).toContain("last_mapped_commit:");
  });

  it("map-codebase works before init files exist", async () => {
    const root = createRoot();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const app = true;\n");
    const ctx = createContext(root);
    const spawn = createMapCodebaseSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx);

    expect(spawn.mock.calls[0]?.[0]?.task).toContain("<required_reading>");
    expect(spawn.mock.calls[0]?.[0]?.task).not.toContain(".planning/PROJECT.md");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain(
      "Write these documents to .planning/codebase/",
    );
    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Codebase map created without last_mapped_commit baseline. Re-run inside git history before relying on `skip` or drift reuse.",
        "warning",
      );
    });
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

  it("map-codebase rejects scoped --paths remap to protect canonical docs", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      paths: ["src", "packages/ui", "../bad", "apps/$oops"],
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase mode: --paths local scoped remap is not yet safe for canonical codebase docs. Run full `/gsd map-codebase`.",
      "warning",
    );
  });

  it("map-codebase fast mode runs one partial non-canonical mapper by default", async () => {
    const root = createPlanningRoot();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    const ctx = createContext(root);
    const pi = createPi() as ExtensionAPI & { sendMessage: ReturnType<typeof vi.fn> };
    const spawn = createFastMapCodebaseSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase(pi, ctx, { fast: true });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]?.name).toBe("codebase-mapper:tech+arch");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain("Focus: tech+arch");
    expect(spawn.mock.calls[0]?.[0]?.task).toContain("Partial scan mode: local `--fast`.");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Started fast codebase map: 1 subagent (tech+arch)",
      "info",
    );
    await vi.waitFor(() => {
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(pi.sendMessage.mock.calls[0]?.[0]?.content).toContain(
      "Focus: tech+arch (partial, non-canonical)",
    );
    expect(pi.sendMessage.mock.calls[0]?.[0]?.content).toContain("STACK.md");
    expect(pi.sendMessage.mock.calls[0]?.[0]?.content).toContain("STRUCTURE.md");
    expect(existsSync(join(root, ".planning", "codebase", "CONVENTIONS.md"))).toBe(false);
  });

  it("map-codebase fast prompts mark every focus as partial non-canonical", () => {
    for (const focus of ["tech", "arch", "quality", "concerns", "tech+arch"] as const) {
      const prompt = buildFastMapperTask(focus, "2026-05-06", createPlanningRoot());
      expect(prompt).toContain("Partial scan mode: local `--fast`.");
      expect(prompt).toContain(
        "This run is non-canonical and must only update target docs for requested focus.",
      );
      expect(prompt).toContain(
        "Do not treat this as a full codebase map refresh or baseline replacement.",
      );
      expect(prompt).toContain("Preserve unrelated codebase docs outside this target set.");
    }
  });

  it("map-codebase fast refresh overwrites only target docs and preserves unrelated docs", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    writeFileSync(join(codebaseDir, "STACK.md"), "stale stack\n");
    writeFileSync(join(codebaseDir, "INTEGRATIONS.md"), "stale integrations\n");
    writeFileSync(join(codebaseDir, "CONCERNS.md"), "keep concerns\n");
    const ctx = createContext(root);
    const spawn = createFastMapCodebaseSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      fast: true,
      focus: "tech",
      existingMode: "refresh",
    });

    await vi.waitFor(() => {
      expect(readFileSync(join(codebaseDir, "STACK.md"), "utf8")).toContain("Detailed analysis");
    });
    expect(readFileSync(join(codebaseDir, "CONCERNS.md"), "utf8")).toContain("keep concerns");
    expect(existsSync(join(codebaseDir, "ARCHITECTURE.md"))).toBe(false);
  });

  it("map-codebase fast mode aborts when target docs exist without explicit overwrite", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    writeFileSync(join(codebaseDir, "STACK.md"), "stale stack\n");
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      fast: true,
      focus: "tech",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Fast map would overwrite existing target docs: STACK.md. Re-run with `/gsd map-codebase --fast refresh` to replace only fast-scan target docs.",
      "warning",
    );
  });

  it("map-codebase fast mode rejects update and skip overwrite modes", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { fast: true, existingMode: "update" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { fast: true, existingMode: "skip" });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase mode: `--fast update` is not allowed locally. Use `/gsd map-codebase --fast refresh` or full `/gsd map-codebase update`.",
      "warning",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase mode: `--fast skip` is not allowed locally. Use `/gsd map-codebase skip` only for canonical full maps.",
      "warning",
    );
  });

  it("map-codebase fast failure restores only target docs", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    writeFileSync(join(codebaseDir, "STACK.md"), "old stack\n");
    writeFileSync(join(codebaseDir, "INTEGRATIONS.md"), "old integrations\n");
    writeFileSync(join(codebaseDir, "CONCERNS.md"), "keep concerns\n");
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => ({
      ok: true,
      value: {
        handle: {
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "Fast Mapping Complete",
          }),
          captureOutput: vi.fn().mockResolvedValue({ text: "## Fast Mapping Complete\nReady" }),
        },
      },
    }));
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      fast: true,
      focus: "tech",
      existingMode: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Fast codebase map failed: Missing codebase map artifact: STACK.md",
        "error",
      );
    });
    expect(readFileSync(join(codebaseDir, "STACK.md"), "utf8")).toContain("old stack");
    expect(readFileSync(join(codebaseDir, "INTEGRATIONS.md"), "utf8")).toContain(
      "old integrations",
    );
    expect(readFileSync(join(codebaseDir, "CONCERNS.md"), "utf8")).toContain("keep concerns");
  });

  it("map-codebase query status runs read-only instead of remapping", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      query: "status",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Intel system disabled. Set intel.enabled=true in config.json to activate.",
      ),
      "info",
    );
  });

  it("map-codebase query status is read-only and does not create planning dir", async () => {
    const root = createRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });

    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".planning"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Intel system disabled. Set intel.enabled=true in config.json to activate.",
      "info",
    );
  });

  it("map-codebase query refresh is rejected before any write path", async () => {
    const root = createRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "refresh" });

    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".planning"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase query mode: `--query refresh` is not implemented locally in this slice.",
      "warning",
    );
  });

  it("map-codebase query reads compatible newer intel filenames", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "files.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z" },
          entries: {
            "src/auth/service.ts": { summary: "auth service" },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "snapshot.json"),
      `${JSON.stringify({ hashes: { "files.json": "deadbeef" } }, null, 2)}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "auth service" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Intel query term: auth service"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("- files.json: present, fresh"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Changed: files.json"),
      "info",
    );
  });

  it("map-codebase rejects positional area arguments instead of remapping", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      unsupportedModeError:
        "Unsupported /gsd map-codebase argument: auth. Local command does not support positional area scoping.",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase argument: auth. Local command does not support positional area scoping.",
      "warning",
    );
  });

  it("map-codebase rejects malformed unsupported flags instead of remapping", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      unsupportedModeError: "Unsupported /gsd map-codebase mode: --query requires a value.",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase mode: --query requires a value.",
      "warning",
    );
  });

  it("map-codebase rejects unknown flags instead of remapping", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      unsupportedModeError: "Unsupported /gsd map-codebase flag: --bogus.",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase flag: --bogus.",
      "warning",
    );
  });

  it("map-codebase stops and asks user to choose refresh update or skip when docs exist", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(join(root, ".planning", "codebase", "STACK.md"), "# Stack\n");
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx);

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      ".planning/codebase already exists: STACK.md Choose next step: `/gsd map-codebase refresh` or `/gsd map-codebase update`. `skip` unavailable until full codebase map exists.",
      "warning",
    );
  });

  it("map-codebase does not offer skip for incomplete existing docs", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(join(root, ".planning", "codebase", "STACK.md"), "# Stack\n");
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx);

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      ".planning/codebase already exists: STACK.md Choose next step: `/gsd map-codebase refresh` or `/gsd map-codebase update`. `skip` unavailable until full codebase map exists.",
      "warning",
    );
  });

  it("map-codebase skip mode preserves existing docs without remapping", async () => {
    const root = createPlanningRoot();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    for (const document of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      writeFileSync(join(codebaseDir, document), `# ${document}\n\nBody\n`);
    }
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    for (const document of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      writeFileSync(
        join(codebaseDir, document),
        `---\nlast_mapped_commit: ${commitSha}\nlast_mapped_at: 2026-05-06T00:00:00.000Z\n---\n# ${document}\n\nDetailed analysis for ${document}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "skip" });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      `Using existing codebase map: ${join(root, ".planning", "codebase")}`,
      "info",
    );
  });

  it("map-codebase skip mode rejects valid unstamped docs", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    for (const document of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      writeFileSync(
        join(codebaseDir, document),
        `# ${document}\n\nDetailed analysis for ${document}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "skip" });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Existing `.planning/codebase/` docs are missing last_mapped_commit metadata. `skip` unavailable. Use `/gsd map-codebase refresh` or `/gsd map-codebase update`.",
      "warning",
    );
  });

  it("map-codebase skip mode rejects when no canonical map exists", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "skip" });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No canonical `.planning/codebase/` map exists yet. `skip` unavailable. Run `/gsd map-codebase` or `/gsd map-codebase update`.",
      "warning",
    );
  });

  it("map-codebase does not advertise skip for valid docs without reusable baseline", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    for (const document of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      writeFileSync(
        join(codebaseDir, document),
        `# ${document}\n\nDetailed analysis for ${document}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx);

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      ".planning/codebase already exists: ARCHITECTURE.md, CONCERNS.md, CONVENTIONS.md, INTEGRATIONS.md, STACK.md, STRUCTURE.md, TESTING.md Choose next step: `/gsd map-codebase refresh` or `/gsd map-codebase update`. `skip` unavailable until full codebase map exists.",
      "warning",
    );
  });

  it("map-codebase skip mode rejects invalid mapped commit metadata", async () => {
    const root = createPlanningRoot();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    for (const document of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      writeFileSync(
        join(codebaseDir, document),
        `---\nlast_mapped_commit: deadbeef\nlast_mapped_at: 2026-05-06T00:00:00.000Z\n---\n# ${document}\n\nDetailed analysis for ${document}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "skip" });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Existing `.planning/codebase/` docs do not share one valid reachable last_mapped_commit baseline. `skip` unavailable. Use `/gsd map-codebase refresh` or `/gsd map-codebase update`.",
      "warning",
    );
  });

  it("map-codebase skip mode rejects non-ancestor mapped baseline", async () => {
    const root = createPlanningRoot();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    const baseBranch = execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", ["checkout", "-b", "side"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "SIDE.md"), "side\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "side"], { cwd: root, stdio: "ignore" });
    const sideCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("git", ["checkout", baseBranch], { cwd: root, stdio: "ignore" });
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    for (const document of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      writeFileSync(
        join(codebaseDir, document),
        `---\nlast_mapped_commit: ${sideCommit}\nlast_mapped_at: 2026-05-06T00:00:00.000Z\n---\n# ${document}\n\nDetailed analysis for ${document}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "skip" });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Existing `.planning/codebase/` docs do not share one valid reachable last_mapped_commit baseline. `skip` unavailable. Use `/gsd map-codebase refresh` or `/gsd map-codebase update`.",
      "warning",
    );
  });

  it("map-codebase skip mode rejects mixed mapped commit baselines", async () => {
    const root = createPlanningRoot();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    for (const document of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      const baseline = document === "STACK.md" ? commitSha : "deadbeef";
      writeFileSync(
        join(codebaseDir, document),
        `---\nlast_mapped_commit: ${baseline}\nlast_mapped_at: 2026-05-06T00:00:00.000Z\n---\n# ${document}\n\nDetailed analysis for ${document}.\nConcrete file paths and patterns.\nActionable implementation guidance.\n`,
      );
    }
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "skip" });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Existing `.planning/codebase/` docs do not share one valid reachable last_mapped_commit baseline. `skip` unavailable. Use `/gsd map-codebase refresh` or `/gsd map-codebase update`.",
      "warning",
    );
  });

  it("map-codebase skip mode rejects incomplete existing docs", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(join(root, ".planning", "codebase", "STACK.md"), "# Stack\n");
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "skip" });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Existing `.planning/codebase/` docs are incomplete or invalid. `skip` unavailable. Use `/gsd map-codebase refresh` or `/gsd map-codebase update`.",
      "warning",
    );
  });

  it("map-codebase refresh mode clears old docs before remapping", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    writeFileSync(join(codebaseDir, "STACK.md"), "stale\n");
    writeFileSync(join(codebaseDir, "NOTES.md"), "keep\n");
    const ctx = createContext(root);
    const spawn = createMapCodebaseSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "refresh" });

    expect(readFileSync(join(codebaseDir, "STACK.md"), "utf8")).toContain("Detailed analysis");
    expect(readFileSync(join(codebaseDir, "NOTES.md"), "utf8")).toContain("keep");
  });

  it("map-codebase update mode clears expected artifacts before remapping", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    writeFileSync(join(codebaseDir, "STACK.md"), "stale stack\n");
    writeFileSync(join(codebaseDir, "TESTING.md"), "stale testing\n");
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async ({ task }: { task?: string }) => {
      const taskText = String(task ?? "");
      mkdirSync(codebaseDir, { recursive: true });
      if (taskText.includes("Focus: tech")) {
        writeFileSync(join(codebaseDir, "INTEGRATIONS.md"), "# INTEGRATIONS.md\n\nBody\nBody\n");
      }
      if (taskText.includes("Focus: arch")) {
        writeFileSync(join(codebaseDir, "ARCHITECTURE.md"), "# ARCHITECTURE.md\n\nBody\nBody\n");
        writeFileSync(join(codebaseDir, "STRUCTURE.md"), "# STRUCTURE.md\n\nBody\nBody\n");
      }
      if (taskText.includes("Focus: quality")) {
        writeFileSync(join(codebaseDir, "CONVENTIONS.md"), "# CONVENTIONS.md\n\nBody\nBody\n");
      }
      if (taskText.includes("Focus: concerns")) {
        writeFileSync(join(codebaseDir, "CONCERNS.md"), "# CONCERNS.md\n\nBody\nBody\n");
      }
      return {
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
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "update" });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Codebase map failed: Missing codebase map artifact: STACK.md",
        "error",
      );
    });
    expect(readFileSync(join(codebaseDir, "STACK.md"), "utf8")).toContain("stale stack");
    expect(readFileSync(join(codebaseDir, "TESTING.md"), "utf8")).toContain("stale testing");
  });

  it("map-codebase refresh does not delete existing docs before invalid scoped paths abort", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    writeFileSync(join(codebaseDir, "OLD.md"), "stale\n");
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      existingMode: "refresh",
      paths: ["../bad"],
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase mode: --paths local scoped remap is not yet safe for canonical codebase docs. Run full `/gsd map-codebase`.",
      "warning",
    );
    expect(existsSync(join(codebaseDir, "OLD.md"))).toBe(true);
  });

  it("map-codebase removes partial canonical docs after failed first run", async () => {
    const root = createPlanningRoot();
    const codebaseDir = join(root, ".planning", "codebase");
    mkdirSync(codebaseDir, { recursive: true });
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async ({ task }: { task?: string }) => {
      const taskText = String(task ?? "");
      if (taskText.includes("Focus: tech")) {
        writeFileSync(
          join(codebaseDir, "STACK.md"),
          "# STACK.md\n\nDetailed analysis.\nConcrete file paths.\nActionable guidance.\n",
        );
      }
      return {
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
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "update" });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Codebase map failed: Missing codebase map artifact: INTEGRATIONS.md",
        "error",
      );
    });
    for (const name of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      expect(existsSync(join(codebaseDir, name))).toBe(false);
    }
  });

  it("map-codebase routes mapper spawn failures through detached error handling", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: false,
      error: { message: "spawn exploded" },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "update" });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith("Codebase map failed: spawn exploded", "error");
    });
  });

  it("map-codebase update mode clarifies full in-place refresh semantics", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    writeFileSync(join(root, ".planning", "codebase", "STACK.md"), "# Stack\n");
    const ctx = createContext(root);
    const spawn = createMapCodebaseSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "update" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Local `/gsd map-codebase update` refreshes full codebase map in place.",
      "info",
    );
  });

  it("map-codebase fails if expected artifacts are missing", async () => {
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

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "update" });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Codebase map failed: Missing codebase map artifact: STACK.md",
        "error",
      );
    });
  });

  it("map-codebase fails if artifact body is frontmatter only", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async ({ task }: { task?: string }) => {
      const taskText = String(task ?? "");
      const documents: string[] = [];
      if (taskText.includes("Focus: tech")) {
        documents.push("STACK.md", "INTEGRATIONS.md");
      }
      if (taskText.includes("Focus: arch")) {
        documents.push("ARCHITECTURE.md", "STRUCTURE.md");
      }
      if (taskText.includes("Focus: quality")) {
        documents.push("CONVENTIONS.md", "TESTING.md");
      }
      if (taskText.includes("Focus: concerns")) {
        documents.push("CONCERNS.md");
      }
      mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
      for (const document of documents) {
        writeFileSync(
          join(root, ".planning", "codebase", document),
          document === "STACK.md"
            ? "---\nlast_mapped_commit: abc\n---\n"
            : `# ${document}\n\nBody\n`,
        );
      }
      return {
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
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "update" });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Codebase map failed: Invalid codebase map artifact body: STACK.md",
        "error",
      );
    });
  });

  it("map-codebase fails if artifact body is only a stub heading", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async ({ task }: { task?: string }) => {
      const taskText = String(task ?? "");
      const documents: string[] = [];
      if (taskText.includes("Focus: tech")) {
        documents.push("STACK.md", "INTEGRATIONS.md");
      }
      if (taskText.includes("Focus: arch")) {
        documents.push("ARCHITECTURE.md", "STRUCTURE.md");
      }
      if (taskText.includes("Focus: quality")) {
        documents.push("CONVENTIONS.md", "TESTING.md");
      }
      if (taskText.includes("Focus: concerns")) {
        documents.push("CONCERNS.md");
      }
      mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
      for (const document of documents) {
        writeFileSync(
          join(root, ".planning", "codebase", document),
          document === "STACK.md" ? "# Stack\n" : `# ${document}\n\nBody\nBody\n`,
        );
      }
      return {
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
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { existingMode: "update" });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Codebase map failed: Invalid codebase map artifact body: STACK.md",
        "error",
      );
    });
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
