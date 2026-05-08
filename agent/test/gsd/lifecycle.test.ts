import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { readRoadmapPhases } from "../../src/extensions/gsd/state/roadmap.js";
import {
  loadPriorDiscussContext,
  scoutDiscussCodebase,
} from "../../src/extensions/gsd/state/discuss.js";
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
import { handleGsdSecurePhase } from "../../src/extensions/gsd/lifecycle/secure-phase.js";
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
**Requirements**: [REQ-2]
**Canonical refs**: [\`docs/feature.md\`, \`docs/api.md\`]

Plans:
- [ ] 02-01: Implement feature
`,
  );
  writeFileSync(
    join(root, ".planning", "REQUIREMENTS.md"),
    "# Requirements\n\n- REQ-2 feature contract\n",
  );
  writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n\nProject constraints.\n");
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: \nstatus: Ready to plan\n",
  );
  writeFileSync(join(root, resolveInstructionFileName()), "project instructions\n");
  return root;
}

function setDiscussModeAssumptions(root: string): void {
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
        workflow: {
          discuss_mode: "assumptions",
        },
      },
      null,
      2,
    )}\n`,
  );
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

function createInteractiveContext(
  cwd: string,
  options?: { selects?: Array<string | undefined>; inputs?: Array<string | undefined> },
): ExtensionCommandContext {
  const ctx = createContext(cwd) as ExtensionCommandContext & {
    ui: ExtensionCommandContext["ui"] & {
      select: ReturnType<typeof vi.fn>;
      input: ReturnType<typeof vi.fn>;
    };
  };
  const selects = [...(options?.selects ?? [])];
  const inputs = [...(options?.inputs ?? [])];
  ctx.hasUI = true;
  ctx.ui.select = vi.fn(async () => selects.shift());
  ctx.ui.input = vi.fn(async () => inputs.shift());
  return ctx;
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

function createIntelRefreshSpawn(
  root: string,
  options?: {
    marker?: boolean;
    snapshot?: boolean;
    changed?: boolean;
    validArch?: boolean;
    mismatchedSnapshotHashes?: boolean;
    staleSnapshotTimestamp?: boolean;
    writeLegacyFallback?: boolean;
    staleArtifactTimestamps?: boolean;
  },
) {
  return vi.fn().mockImplementation(async () => {
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const main = true;\n");
    writeFileSync(join(root, "src", "config.ts"), "export const config = {};\n");
    writeFileSync(join(root, "src", "server.ts"), "export const health = true;\n");
    const artifactUpdatedAt =
      options?.staleArtifactTimestamps === true
        ? "2020-01-01T00:00:00.000Z"
        : new Date().toISOString();
    if (options?.changed !== false || !existsSync(join(root, ".planning", "intel", "files.json"))) {
      writeFileSync(
        join(root, ".planning", "intel", "files.json"),
        `${JSON.stringify(
          {
            _meta: { updated_at: artifactUpdatedAt, version: 1 },
            entries: {
              "src/index.ts": { exports: ["main"], imports: ["./config"], type: "entry-point" },
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(root, ".planning", "intel", "apis.json"),
        `${JSON.stringify(
          {
            _meta: { updated_at: artifactUpdatedAt, version: 1 },
            entries: {
              "GET /health": {
                method: "GET",
                path: "/health",
                params: [],
                file: "src/server.ts",
                description: "health",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(root, ".planning", "intel", "deps.json"),
        `${JSON.stringify(
          {
            _meta: { updated_at: artifactUpdatedAt, version: 1 },
            entries: {
              vitest: {
                version: "^1.0.0",
                type: "development",
                used_by: ["npm test"],
                invocation: "npm test",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(root, ".planning", "intel", "stack.json"),
        `${JSON.stringify(
          {
            _meta: { updated_at: artifactUpdatedAt, version: 1 },
            languages: ["TypeScript"],
            frameworks: [],
            tools: ["Vitest"],
            build_system: "npm scripts",
            test_framework: "Vitest",
            package_manager: "npm",
            content_formats: ["Markdown", "JSON"],
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(root, ".planning", "intel", "arch.md"),
        options?.validArch === false
          ? "# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n"
          : `---\nupdated_at: \"${artifactUpdatedAt}\"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`,
      );
      if (options?.writeLegacyFallback === true) {
        writeFileSync(
          join(root, ".planning", "intel", "file-roles.json"),
          `${JSON.stringify(
            {
              _meta: { updated_at: new Date().toISOString(), version: 1 },
              entries: {
                "src/legacy-written.ts": { exports: ["legacy"], imports: [], type: "module" },
              },
            },
            null,
            2,
          )}\n`,
        );
      }
    }
    if (options?.snapshot !== false) {
      const filesHash = createHash("sha256")
        .update(readFileSync(join(root, ".planning", "intel", "files.json"), "utf8"))
        .digest("hex");
      const apisHash = createHash("sha256")
        .update(readFileSync(join(root, ".planning", "intel", "apis.json"), "utf8"))
        .digest("hex");
      const depsHash = createHash("sha256")
        .update(readFileSync(join(root, ".planning", "intel", "deps.json"), "utf8"))
        .digest("hex");
      const archHash = createHash("sha256")
        .update(readFileSync(join(root, ".planning", "intel", "arch.md"), "utf8"))
        .digest("hex");
      const stackHash = createHash("sha256")
        .update(readFileSync(join(root, ".planning", "intel", "stack.json"), "utf8"))
        .digest("hex");
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp:
              options?.staleSnapshotTimestamp === true
                ? "2020-01-01T00:00:00.000Z"
                : new Date().toISOString(),
            hashes: {
              "files.json":
                options?.mismatchedSnapshotHashes === true
                  ? "wrong-files-hash"
                  : options?.changed === false
                    ? filesHash
                    : filesHash,
              "apis.json":
                options?.mismatchedSnapshotHashes === true ? "wrong-apis-hash" : apisHash,
              "deps.json":
                options?.mismatchedSnapshotHashes === true ? "wrong-deps-hash" : depsHash,
              "arch.md": options?.mismatchedSnapshotHashes === true ? "wrong-arch-hash" : archHash,
              "stack.json":
                options?.mismatchedSnapshotHashes === true ? "wrong-stack-hash" : stackHash,
            },
          },
          null,
          2,
        )}\n`,
      );
    }
    return {
      ok: true,
      value: {
        handle: {
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "intel-session-id",
            status: "completed",
            summary: options?.marker === false ? "done" : "## INTEL UPDATE COMPLETE",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: options?.marker === false ? "done" : "## INTEL UPDATE COMPLETE",
          }),
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
        "Codebase map created without reusable `last_mapped_commit` baseline. Repo had no committed `HEAD` or worktree was dirty before mapping. Commit or clean the worktree, then re-run before relying on `skip` or drift reuse.",
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

  it("map-codebase query refresh stays read-only when intel disabled", async () => {
    const root = createRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "refresh" });

    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".planning"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Intel system disabled. Set intel.enabled=true in config.json to activate.",
      "info",
    );
  });

  it("map-codebase does not stamp reusable last_mapped_commit baseline from dirty worktree", async () => {
    const root = createPlanningRoot();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "untracked.txt"), "dirty\n");

    const codebaseDir = join(root, ".planning", "codebase");
    const spawn = createMapCodebaseSpawn(root);
    const pi = createPi();
    const ctx = createContext(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase(pi as unknown as ExtensionAPI, ctx, {});

    await vi.waitFor(() => {
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    });

    const structureDoc = readFileSync(join(codebaseDir, "STRUCTURE.md"), "utf8");
    expect(structureDoc).not.toContain("last_mapped_commit:");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Codebase map created without reusable `last_mapped_commit` baseline. Repo had no committed `HEAD` or worktree was dirty before mapping. Commit or clean the worktree, then re-run before relying on `skip` or drift reuse.",
      "warning",
    );
  });

  it("map-codebase query refresh spawns intel updater and verifies canonical outputs", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "intel", "files.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const pi = createPi();
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase(pi as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith("Intel refresh updated: .planning/intel", "info");
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]?.mode).toBe("gsd-intel-updater");
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "gsd-intel-refresh-summary" }),
      { deliverAs: "steer", triggerTurn: false },
    );
  });

  it("map-codebase query refresh removes legacy fallback intel files after success", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "file-roles.json"),
      `${JSON.stringify({ _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 }, entries: {} }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "snapshot.json"),
      `${JSON.stringify({ timestamp: "2026-05-06T00:00:00.000Z", hashes: {} }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith("Intel refresh updated: .planning/intel", "info");
    });
    expect(existsSync(join(root, ".planning", "intel", "file-roles.json"))).toBe(false);
    expect(existsSync(join(root, ".planning", "intel", "snapshot.json"))).toBe(false);
  });

  it("map-codebase query refresh fails when completion marker missing", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root, { marker: false });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "refresh" });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel updater finished without required completion marker",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when arch.md frontmatter is invalid", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root, { validArch: false });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Intel refresh failed: Intel validation failed: arch.md: missing YAML frontmatter",
        ),
        "error",
      );
    });
  });

  it("map-codebase query refresh succeeds when canonical intel is already current", async () => {
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
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "src/index.ts": { exports: ["main"], imports: ["./config"], type: "entry-point" },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "apis.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "GET /health": {
              method: "GET",
              path: "/health",
              params: [],
              file: "src/server.ts",
              description: "health",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "deps.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "stack.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "arch.md"),
      `---\nupdated_at: \"${new Date().toISOString()}\"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`,
    );
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root, { changed: false });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith("Intel refresh updated: .planning/intel", "info");
    });
  });

  it("map-codebase query refresh fails when snapshot hashes do not match current intel files", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root, { mismatchedSnapshotHashes: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel snapshot hash mismatch for: files.json",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when deps.json entries omit invocation", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "src/index.ts": { exports: ["main"], imports: ["./config"], type: "entry-point" },
          },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: { vitest: { version: "^1.0.0", type: "development", used_by: ["npm test"] } },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: \"${new Date().toISOString()}\"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Invalid canonical intel schema: deps.json",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when files.json violates canonical schema", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: { "src/index.ts": { imports: ["./config"], type: "entry-point" } },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: \"${new Date().toISOString()}\"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Invalid canonical intel schema: files.json",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when files.json has invalid _meta.updated_at", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const main = true;\n");
    writeFileSync(join(root, "src", "config.ts"), "export const config = {};\n");
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: "not-a-date", version: 1 },
          entries: {
            "src/index.ts": { exports: ["main"], imports: ["./config"], type: "entry-point" },
          },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: "${new Date().toISOString()}"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel validation failed: files.json: invalid _meta.updated_at",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when apis.json violates canonical schema", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "src/index.ts": { exports: ["main"], imports: ["./config"], type: "entry-point" },
          },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "GET /health": {
              path: "/health",
              params: [],
              file: "src/server.ts",
              description: "health",
            },
          },
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: \"${new Date().toISOString()}\"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Invalid canonical intel schema: apis.json",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when files.json references nonexistent paths", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root);
    writeFileSync(join(root, "src-placeholder.ts"), "export const placeholder = true;\n");
    setGsdSubagentSdkFactoryForTests(
      () =>
        ({
          spawn: vi.fn().mockImplementation(async () => {
            await spawn();
            const filesPath = join(root, ".planning", "intel", "files.json");
            const filesJson = JSON.parse(readFileSync(filesPath, "utf8")) as {
              _meta: { updated_at: string; version: number };
              entries: Record<string, { exports: string[]; imports: string[]; type: string }>;
            };
            filesJson.entries = {
              "src/missing.ts": {
                exports: ["missing"],
                imports: ["./also-missing"],
                type: "module",
              },
            };
            const filesContent = `${JSON.stringify(filesJson, null, 2)}\n`;
            writeFileSync(filesPath, filesContent);
            const snapshotPath = join(root, ".planning", "intel", ".last-refresh.json");
            const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
              timestamp: string;
              hashes: Record<string, string>;
            };
            snapshot.hashes["files.json"] = createHash("sha256").update(filesContent).digest("hex");
            writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
            return {
              ok: true,
              value: {
                handle: {
                  waitForCompletion: vi.fn().mockResolvedValue({
                    sessionId: "intel-session-id",
                    status: "completed",
                    summary: "## INTEL UPDATE COMPLETE",
                  }),
                  captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
                },
              },
            };
          }),
        }) as never,
    );

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel validation failed: files.json: missing files.json entry path: src/missing.ts",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when files.json imports nonexistent in-repo relative path", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const main = true;\n");
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "src/index.ts": { exports: ["main"], imports: ["./missing"], type: "entry-point" },
          },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: "${new Date().toISOString()}"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel validation failed: files.json: missing files.json import path: src/index.ts -> ./missing",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when apis.json references nonexistent files", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const main = true;\n");
    writeFileSync(join(root, "src", "config.ts"), "export const config = {};\n");
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "src/index.ts": { exports: ["main"], imports: ["./config"], type: "entry-point" },
          },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "GET /health": {
              method: "GET",
              path: "/health",
              params: [],
              file: "src/server.ts",
              description: "health",
            },
          },
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: "${new Date().toISOString()}"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel validation failed: apis.json: missing apis.json file path: src/server.ts",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when canonical intel references out-of-repo files", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const main = true;\n");
    writeFileSync(join(root, "src", "config.ts"), "export const config = {};\n");
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "../outside.ts": { exports: ["outside"], imports: [], type: "module" },
          },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: "${new Date().toISOString()}"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel validation failed: files.json: missing files.json entry path: ../outside.ts",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when canonical intel relies on directory fallback", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src", "feature"), { recursive: true });
    writeFileSync(join(root, "src", "feature", "index.ts"), "export const feature = true;\n");
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "src/feature": { exports: ["feature"], imports: [], type: "module" },
          },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: "${new Date().toISOString()}"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel validation failed: files.json: missing files.json entry path: src/feature",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when apis.json.file relies on extension probing", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "server.ts"), "export const health = true;\n");
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "GET /health": {
              method: "GET",
              path: "/health",
              params: [],
              file: "src/server",
              description: "health",
            },
          },
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: "${new Date().toISOString()}"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel validation failed: apis.json: missing apis.json file path: src/server",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when stack.json violates canonical schema", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockImplementation(async () => {
      mkdirSync(join(root, ".planning", "intel"), { recursive: true });
      const filesContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            "src/index.ts": { exports: ["main"], imports: ["./config"], type: "entry-point" },
          },
        },
        null,
        2,
      )}\n`;
      const apisContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`;
      const depsContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          entries: {
            vitest: {
              version: "^1.0.0",
              type: "development",
              used_by: ["npm test"],
              invocation: "npm test",
            },
          },
        },
        null,
        2,
      )}\n`;
      const stackContent = `${JSON.stringify(
        {
          _meta: { updated_at: new Date().toISOString(), version: 1 },
          frameworks: [],
          tools: ["Vitest"],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`;
      const archContent = `---\nupdated_at: \"${new Date().toISOString()}\"\n---\n\n# Architecture\n\nMain flow.\nKey modules.\nBoundaries and conventions.\n`;
      writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
      writeFileSync(join(root, ".planning", "intel", "apis.json"), apisContent);
      writeFileSync(join(root, ".planning", "intel", "deps.json"), depsContent);
      writeFileSync(join(root, ".planning", "intel", "stack.json"), stackContent);
      writeFileSync(join(root, ".planning", "intel", "arch.md"), archContent);
      writeFileSync(
        join(root, ".planning", "intel", ".last-refresh.json"),
        `${JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            hashes: {
              "files.json": createHash("sha256").update(filesContent).digest("hex"),
              "apis.json": createHash("sha256").update(apisContent).digest("hex"),
              "deps.json": createHash("sha256").update(depsContent).digest("hex"),
              "arch.md": createHash("sha256").update(archContent).digest("hex"),
              "stack.json": createHash("sha256").update(stackContent).digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      return {
        ok: true,
        value: {
          handle: {
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "intel-session-id",
              status: "completed",
              summary: "## INTEL UPDATE COMPLETE",
            }),
            captureOutput: vi.fn().mockResolvedValue({ text: "## INTEL UPDATE COMPLETE" }),
          },
        },
      };
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Invalid canonical intel schema: stack.json",
        "error",
      );
    });
  });

  it("map-codebase query refresh restores previous intel files after verification failure", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const originalFilesContent = `${JSON.stringify(
      {
        _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
        entries: { "src/original.ts": { exports: ["original"], imports: [], type: "module" } },
      },
      null,
      2,
    )}\n`;
    const originalSnapshotContent = `${JSON.stringify(
      {
        timestamp: "2026-05-06T00:00:00.000Z",
        hashes: {
          "files.json": createHash("sha256").update(originalFilesContent).digest("hex"),
          "apis.json": "orig-apis",
          "deps.json": "orig-deps",
          "arch.md": "orig-arch",
          "stack.json": "orig-stack",
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(root, ".planning", "intel", "files.json"), originalFilesContent);
    writeFileSync(
      join(root, ".planning", "intel", "apis.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "deps.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {},
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "stack.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          languages: ["TypeScript"],
          frameworks: [],
          tools: [],
          build_system: "npm scripts",
          test_framework: "Vitest",
          package_manager: "npm",
          content_formats: ["Markdown", "JSON"],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "arch.md"),
      `---\nupdated_at: \"2026-05-06T00:00:00.000Z\"\n---\n\n# Architecture\n\nOriginal architecture.\nOriginal components.\nOriginal boundaries.\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "file-roles.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {
            "src/original-legacy.ts": { exports: ["originalLegacy"], imports: [], type: "module" },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(root, ".planning", "intel", ".last-refresh.json"), originalSnapshotContent);

    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root, {
      mismatchedSnapshotHashes: true,
      writeLegacyFallback: true,
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel snapshot hash mismatch for: files.json",
        "error",
      );
    });

    expect(readFileSync(join(root, ".planning", "intel", "files.json"), "utf8")).toBe(
      originalFilesContent,
    );
    expect(readFileSync(join(root, ".planning", "intel", "file-roles.json"), "utf8")).toBe(
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {
            "src/original-legacy.ts": { exports: ["originalLegacy"], imports: [], type: "module" },
          },
        },
        null,
        2,
      )}\n`,
    );
    expect(readFileSync(join(root, ".planning", "intel", ".last-refresh.json"), "utf8")).toBe(
      originalSnapshotContent,
    );
  });

  it("map-codebase query refresh fails when snapshot timestamp predates invocation", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root, { staleSnapshotTimestamp: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Intel refresh failed: Intel snapshot timestamp predates this refresh invocation",
        "error",
      );
    });
  });

  it("map-codebase query refresh fails when regenerated intel is already stale", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/old.ts": { exports: ["old"], imports: [], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = createIntelRefreshSpawn(root, { staleArtifactTimestamps: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({ sendMessage: vi.fn() } as unknown as ExtensionAPI, ctx, {
      query: "refresh",
    });

    await vi.waitFor(() => {
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "Intel refresh failed: Intel validation failed: stale outputs detected",
        ),
        "error",
      );
    });
  });

  it("map-codebase query reads compatible newer intel filenames", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src", "auth"), { recursive: true });
    writeFileSync(join(root, "src", "auth", "service.ts"), "export const authService = true;\n");
    writeFileSync(join(root, "src", "auth", "deps.ts"), "export const deps = true;\n");
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "files.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {
            "src/auth/service.ts": {
              exports: ["authService"],
              imports: ["./deps"],
              type: "module",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "snapshot.json"),
      `${JSON.stringify(
        { timestamp: "2026-05-06T00:00:00.000Z", hashes: { "files.json": "deadbeef" } },
        null,
        2,
      )}\n`,
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
      expect.stringContaining("- files.json: present, stale"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Changed: files.json"),
      "info",
    );
  });

  it("map-codebase query treats reference-broken canonical intel as invalid", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {
            "src/missing.ts": {
              exports: ["missing"],
              imports: ["./also-missing"],
              type: "module",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify(
        { timestamp: "2026-05-06T00:00:00.000Z", hashes: { "files.json": "deadbeef" } },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "missing" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid intel file: files.json (missing files.json entry path: src/missing.ts)",
      ),
      "info",
    );
  });

  it("map-codebase query status treats reference-broken canonical intel as invalid and stale", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "apis.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {
            "GET /health": {
              method: "GET",
              path: "/health",
              params: [],
              file: "src/server.ts",
              description: "health",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid intel file: apis.json (missing apis.json file path: src/server.ts)",
      ),
      "info",
    );
  });

  it("map-codebase query diff treats reference-broken canonical intel as invalid", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const filesContent = `${JSON.stringify(
      {
        _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
        entries: {
          "src/missing.ts": {
            exports: ["missing"],
            imports: ["./also-missing"],
            type: "module",
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify(
        {
          timestamp: "2026-05-06T00:00:00.000Z",
          hashes: { "files.json": createHash("sha256").update(filesContent).digest("hex") },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid intel file: files.json (missing files.json entry path: src/missing.ts)",
      ),
      "info",
    );
  });

  it("map-codebase query status treats out-of-repo canonical API refs as invalid", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "apis.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {
            "GET /escape": {
              method: "GET",
              path: "/escape",
              params: [],
              file: "../outside.ts",
              description: "escape",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid intel file: apis.json (missing apis.json file path: ../outside.ts)",
      ),
      "info",
    );
  });

  it("map-codebase query treats files.json entry path relying on extension probing as invalid", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "entry.ts"), "export const entry = true;\n");
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "files.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: {
            "src/entry": {
              exports: ["entry"],
              imports: [],
              type: "module",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "entry" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid intel file: files.json (missing files.json entry path: src/entry)",
      ),
      "info",
    );
  });

  it("map-codebase query prefers current intel filenames over stale legacy files", async () => {
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
          entries: { "src/current.ts": { summary: "current auth service" } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "file-roles.json"),
      `${JSON.stringify(
        {
          _meta: { updated_at: "2026-01-01T00:00:00.000Z" },
          entries: { "src/legacy.ts": { summary: "legacy auth service" } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "arch.md"),
      `---\nupdated_at: \"2026-05-06T00:00:00.000Z\"\n---\n\n# Architecture\n\nauth service in markdown\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "current auth" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("files.json (preferred over file-roles.json)"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("arch.md: present"), "info");
  });

  it("map-codebase query status marks malformed arch.md invalid and stale", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(join(root, ".planning", "intel", "arch.md"), "# Architecture\n\nbad arch\n");
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("arch.md: present, stale"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid intel file: arch.md (missing YAML frontmatter)"),
      "info",
    );
  });

  it("map-codebase query searches arch.md and diffs it", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", "arch.md"),
      `---\nupdated_at: \"2026-05-06T00:00:00.000Z\"\n---\n\n# Architecture\n\npayment flow\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify(
        { timestamp: "2026-05-06T00:00:00.000Z", hashes: { "arch.md": "deadbeef" } },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "payment" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Source: arch.md"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Changed: arch.md"), "info");
  });

  it("map-codebase query does not search malformed arch.md and surfaces it invalid", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(join(root, ".planning", "intel", "arch.md"), "# Architecture\n\npayment flow\n");
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "payment" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid intel file: arch.md (missing YAML frontmatter)"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Source: arch.md"),
      "info",
    );
  });

  it("map-codebase query diff does not diff malformed arch.md and surfaces it invalid", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(join(root, ".planning", "intel", "arch.md"), "# Architecture\n\npayment flow\n");
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify(
        { timestamp: "2026-05-06T00:00:00.000Z", hashes: { "arch.md": "deadbeef" } },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid intel file: arch.md (missing YAML frontmatter)"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Changed: arch.md"),
      "info",
    );
  });

  it("map-codebase query treats schema-invalid current canonical files.json as invalid", async () => {
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
          _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
          entries: { "src/auth/service.ts": { imports: ["./x"], type: "module" } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify({ hashes: { "files.json": "deadbeef" } }, null, 2)}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "auth" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid intel file: files.json (invalid files.json exports)"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Source: files.json"),
      "info",
    );
  });

  it("map-codebase query status treats invalid canonical updated_at as invalid and stale", async () => {
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
          _meta: { updated_at: "not-a-date", version: 1 },
          entries: {
            "src/auth/service.ts": {
              exports: ["authService"],
              imports: ["./deps"],
              type: "module",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("files.json: present, stale"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid intel file: files.json (invalid _meta.updated_at)"),
      "info",
    );
  });

  it("map-codebase query diff reports malformed baseline as unavailable", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(join(root, ".planning", "intel", ".last-refresh.json"), "{not valid json\n");
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Intel diff unavailable: baseline snapshot is invalid."),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Changed: none"),
      "info",
    );
  });

  it("map-codebase query diff reports schema-invalid baseline as unavailable", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify({ timestamp: "2026-05-06T00:00:00.000Z" }, null, 2)}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Intel diff unavailable: baseline snapshot is invalid."),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid intel file: .last-refresh.json (invalid snapshot schema)"),
      "info",
    );
  });

  it("map-codebase query diff matches legacy snapshot keys for canonical intel files", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    const filesContent = `${JSON.stringify(
      {
        _meta: { updated_at: "2026-05-06T00:00:00.000Z", version: 1 },
        entries: {
          "src/auth/service.ts": {
            exports: ["authService"],
            imports: ["./deps"],
            type: "module",
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(root, ".planning", "intel", "files.json"), filesContent);
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify(
        {
          timestamp: "2026-05-06T00:00:00.000Z",
          hashes: {
            "file-roles.json": createHash("sha256").update(filesContent).digest("hex"),
          },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Added: none"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Changed: none"), "info");
  });

  it("map-codebase query diff reports removed canonical intel artifacts", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify(
        {
          timestamp: "2026-05-06T00:00:00.000Z",
          hashes: { "files.json": "deadbeef" },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Removed: files.json"),
      "info",
    );
  });

  it("map-codebase query surfaces malformed intel JSON explicitly", async () => {
    const root = createRoot();
    mkdirSync(join(root, ".planning", "intel"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "config.json"),
      `${JSON.stringify({ intel: { enabled: true } }, null, 2)}\n`,
    );
    writeFileSync(join(root, ".planning", "intel", "files.json"), "{not valid json\n");
    writeFileSync(
      join(root, ".planning", "intel", ".last-refresh.json"),
      `${JSON.stringify({ hashes: { "files.json": "deadbeef" } }, null, 2)}\n`,
    );
    const ctx = createContext(root);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "auth" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "status" });
    await handleGsdMapCodebase({} as ExtensionAPI, ctx, { query: "diff" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid intel file: files.json"),
      "info",
    );
  });

  it("map-codebase query rejects malformed reserved query invocations before write path", async () => {
    const root = createRoot();
    const ctx = createContext(root);
    const spawn = vi.fn();
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdMapCodebase({} as ExtensionAPI, ctx, {
      unsupportedModeError:
        "Unsupported /gsd map-codebase query mode: reserved query `status` does not accept trailing arguments (--fast).",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".planning"))).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd map-codebase query mode: reserved query `status` does not accept trailing arguments (--fast).",
      "warning",
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

  it("discuss-phase writes context and log after routed auto completion", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    const phaseDir = join(root, ".planning", "phases", "2-build");
    const contextPath = join(phaseDir, "02-CONTEXT.md");
    const logPath = join(phaseDir, "02-DISCUSSION-LOG.md");
    expect(readFileSync(contextPath, "utf8")).toContain("<domain>");
    expect(readFileSync(contextPath, "utf8")).toContain("</domain>");
    expect(readFileSync(contextPath, "utf8")).toContain("<decisions>");
    expect(readFileSync(contextPath, "utf8")).toContain("</decisions>");
    expect(readFileSync(contextPath, "utf8")).toContain("<specifics>");
    expect(readFileSync(contextPath, "utf8")).toContain("</specifics>");
    expect(readFileSync(contextPath, "utf8")).toContain("<canonical_refs>");
    expect(readFileSync(contextPath, "utf8")).toContain("</canonical_refs>");
    expect(readFileSync(contextPath, "utf8")).toContain(
      "`docs/feature.md` - Phase canonical ref from ROADMAP.md",
    );
    expect(readFileSync(contextPath, "utf8")).toContain(
      "`docs/api.md` - Phase canonical ref from ROADMAP.md",
    );
    expect(readFileSync(contextPath, "utf8")).toContain("<code_context>");
    expect(readFileSync(contextPath, "utf8")).toContain("</code_context>");
    expect(readFileSync(contextPath, "utf8")).toContain("<deferred>");
    expect(readFileSync(contextPath, "utf8")).toContain("</deferred>");
    expect(readFileSync(contextPath, "utf8")).toContain("## Phase Boundary");
    expect(readFileSync(contextPath, "utf8")).toContain("## Implementation Decisions");
    expect(readFileSync(contextPath, "utf8")).toContain("### Claude's Discretion");
    expect(readFileSync(contextPath, "utf8")).toContain("Follow existing project pattern");
    expect(readFileSync(contextPath, "utf8")).not.toContain(
      "Template for `.planning/phases/XX-name/{phase_num}-CONTEXT.md`",
    );
    expect(readFileSync(logPath, "utf8")).toContain("Existing context branch:");
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(false);
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain(
      "current_phase_name: Build",
    );
  });

  it("discuss-phase non-interactive fallback writes checkpoint but not artifacts", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", all: true });
    const phaseDir = join(root, ".planning", "phases", "2-build");
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(true);
    expect(existsSync(join(phaseDir, "02-CONTEXT.md"))).toBe(false);
    expect(existsSync(join(phaseDir, "02-DISCUSSION-LOG.md"))).toBe(false);
  });

  it("discuss-phase resume preserves checkpoint progress and removes it on completion", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const phaseDir = join(root, ".planning", "phases", "2-build");
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(true);
    const pausedCheckpoint = JSON.parse(
      readFileSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as { stage: string; areaQuestions: Record<string, string[]>; areasRemaining: string[] };
    expect(pausedCheckpoint.stage).toBe("existing-context");
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(false);
    expect(readFileSync(join(phaseDir, "02-CONTEXT.md"), "utf8")).toContain(
      "Follow existing project pattern",
    );
  });

  it("discuss-phase rerun loads existing phase context before prompting", async () => {
    const root = createPlanningRoot();
    const phaseDir = join(root, ".planning", "phases", "2-build");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(
      join(phaseDir, "02-CONTEXT.md"),
      [
        "# CONTEXT",
        "",
        "<domain>",
        "## Phase Boundary",
        "",
        "Phase 2: Build",
        "",
        "</domain>",
        "",
        "<decisions>",
        "## Implementation Decisions",
        "",
        "### Implementation approach",
        "",
        "- **D-01:** Keep existing service layer",
        "",
        "### Claude's Discretion",
        "",
        "- minor naming details",
        "",
        "</decisions>",
        "",
        "<specifics>",
        "## Specific Ideas",
        "",
        "- preserve transport boundary",
        "",
        "</specifics>",
        "",
        "<canonical_refs>",
        "## Canonical References",
        "",
        "- `.planning/PROJECT.md` - Project context source",
        "",
        "</canonical_refs>",
        "",
        "<code_context>",
        "## Existing Code Insights",
        "",
        "- shared/api.ts owns transport concerns",
        "",
        "</code_context>",
        "",
        "<deferred>",
        "## Deferred Ideas",
        "",
        "- admin console later",
        "",
        "</deferred>",
      ].join("\n"),
    );
    writeFileSync(
      join(phaseDir, "02-DISCUSSION-LOG.md"),
      "# DISCUSSION LOG\n\nExisting context preserved.\n",
    );

    const ctx = createContext(root);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });

    const checkpoint = JSON.parse(
      readFileSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as {
      draft: { implementationDecisions: Array<{ decision: string }>; discussionLog: string[] };
      existingContextSummary: string;
    };
    expect(checkpoint.draft.implementationDecisions[0]?.decision).toBe(
      "Keep existing service layer",
    );
    expect(checkpoint.draft.discussionLog).toContain("Existing context preserved.");
    expect(checkpoint.existingContextSummary).toContain(
      "Current phase context loaded with 1 decision",
    );
  });

  it("discuss-phase --all skips picker and processes all areas automatically", async () => {
    const root = createPlanningRoot();
    const ctx = createInteractiveContext(root);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", all: true, auto: true });

    const context = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"),
      "utf8",
    );
    expect(context).toContain("### Implementation approach");
    expect(context).toContain("### Risks and deferrals");
    expect(context).toContain("## Canonical References");
    expect(ctx.ui.select).not.toHaveBeenCalledWith("Select next gray area", expect.anything());
  });

  it("discuss-phase assumptions route writes same artifact contract", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Technical Approach
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
- none
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      auto: true,
    });
    const context = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"),
      "utf8",
    );
    expect(context).toContain("## Phase Boundary");
    expect(context).toContain("<decisions>");
    expect(context).toContain("## Implementation Decisions");
    expect(context).toContain("### Claude's Discretion");
    expect(context).toContain("<canonical_refs>");
    expect(context).toContain("## Canonical References");
    expect(context).toContain("## Existing Code Insights");
    expect(context).toContain("## Specific Ideas");
    expect(context).toContain("## Deferred Ideas");
    expect(context).toContain("D-01");
    expect(context).toContain("Reuse existing service layer");
  });

  it("assumptions mode checkpoints instead of finalizing when external research gaps remain", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Confident

## Needs External Research
- verify vendor API rate limits
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    const phaseDir = join(root, ".planning", "phases", "2-build");
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(true);
    expect(existsSync(join(phaseDir, "02-CONTEXT.md"))).toBe(false);
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain("current_phase: 1");
  });

  it("assumptions resume does not clear unresolved research gaps automatically", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Confident

## Needs External Research
- verify vendor API rate limits
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    const phaseDir = join(root, ".planning", "phases", "2-build");
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(true);
    expect(existsSync(join(phaseDir, "02-CONTEXT.md"))).toBe(false);
    const checkpoint = readFileSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"), "utf8");
    expect(checkpoint).toContain("verify vendor API rate limits");
  });

  it("assumptions research-gap resume can rerun analysis after research is supplied", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          handle: {
            sessionId: "session-id",
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "session-id",
              status: "completed",
              summary: "done",
            }),
            captureOutput: vi.fn().mockResolvedValue({
              text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Confident

## Needs External Research
- verify vendor API rate limits
`,
            }),
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          handle: {
            sessionId: "session-id-2",
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "session-id-2",
              status: "completed",
              summary: "done",
            }),
            captureOutput: vi.fn().mockResolvedValue({
              text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer with vendor rate-limit cache
  - **Why this way:** Research confirmed cache budget is sufficient
  - **If wrong:** Add queue-based throttling
  - **Confidence:** Confident

## Needs External Research
`,
            }),
          },
        },
      });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      auto: true,
      input: "Vendor docs confirm cache budget and retry window.",
    });

    const context = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"),
      "utf8",
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(context).toContain("vendor rate-limit cache");
    expect(context).toContain("If wrong: Add queue-based throttling");
  });

  it("assumptions research-gap rerun persists refreshed checkpoint when gaps still remain", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          handle: {
            sessionId: "session-id",
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "session-id",
              status: "completed",
              summary: "done",
            }),
            captureOutput: vi.fn().mockResolvedValue({
              text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Confident

## Needs External Research
- verify vendor API rate limits
`,
            }),
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          handle: {
            sessionId: "session-id-2",
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "session-id-2",
              status: "completed",
              summary: "done",
            }),
            captureOutput: vi.fn().mockResolvedValue({
              text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer with partial vendor findings
  - **Why this way:** Research reduced unknowns but not enough
  - **If wrong:** Add queue-based throttling
  - **Confidence:** Likely

## Needs External Research
- confirm burst limit policy
`,
            }),
          },
        },
      });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      input: "Vendor docs answered cache behavior but not burst limit.",
    });

    const checkpoint = readFileSync(
      join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json"),
      "utf8",
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(checkpoint).toContain("confirm burst limit policy");
    expect(checkpoint).toContain(
      "Research gap resolution: Vendor docs answered cache behavior but not burst limit.",
    );
  });

  it("assumptions checkpoint supports auto finalize without mutating draft", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    const phaseDir = join(root, ".planning", "phases", "2-build");
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(false);
    const context = readFileSync(join(phaseDir, "02-CONTEXT.md"), "utf8");
    expect(context).toContain("Reuse existing service layer (Likely)");
    expect(context).not.toContain("**D-02:** Confirm assumptions");
  });

  it("discuss-phase chain records handoff only after successful artifact write", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", chain: true, auto: true });
    const log = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-DISCUSSION-LOG.md"),
      "utf8",
    );
    expect(log).toContain("Next step: /gsd plan-phase --phase 2");
  });

  it("rerun finalize preserves hydrated manual refs and deferred notes", async () => {
    const root = createPlanningRoot();
    const phaseDir = join(root, ".planning", "phases", "2-build");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(
      join(phaseDir, "02-CONTEXT.md"),
      [
        "# CONTEXT",
        "",
        "<domain>",
        "## Phase Boundary",
        "",
        "Phase 2: Build",
        "",
        "</domain>",
        "",
        "<decisions>",
        "## Implementation Decisions",
        "",
        "### Implementation approach",
        "",
        "- **D-01:** Keep existing service layer",
        "",
        "### Claude's Discretion",
        "",
        "None",
        "",
        "</decisions>",
        "",
        "<specifics>",
        "## Specific Ideas",
        "",
        "None",
        "",
        "</specifics>",
        "",
        "<canonical_refs>",
        "## Canonical References",
        "",
        "- `docs/manual.md` - Manual carry-over ref",
        "",
        "</canonical_refs>",
        "",
        "<code_context>",
        "## Existing Code Insights",
        "",
        "- existing insight",
        "",
        "</code_context>",
        "",
        "<deferred>",
        "## Deferred Ideas",
        "",
        "- keep analytics follow-up deferred",
        "",
        "</deferred>",
      ].join("\n"),
    );
    writeFileSync(join(phaseDir, "02-DISCUSSION-LOG.md"), "# DISCUSSION LOG\n\nprior note\n");
    const ctx = createContext(root);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });

    const context = readFileSync(join(phaseDir, "02-CONTEXT.md"), "utf8");
    expect(context).toContain("`docs/manual.md` - Manual carry-over ref");
    expect(context).toContain("keep analytics follow-up deferred");
  });

  it("assumptions artifact rerun refreshes analysis even when context already exists", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const phaseDir = join(root, ".planning", "phases", "2-build");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(
      join(phaseDir, "02-CONTEXT.md"),
      [
        "# CONTEXT",
        "",
        "<domain>",
        "## Phase Boundary",
        "",
        "Phase 2: Build",
        "",
        "</domain>",
        "",
        "<decisions>",
        "## Implementation Decisions",
        "",
        "### Delivery",
        "",
        "- **D-01:** Stale assumption from older run",
        "",
        "### Claude's Discretion",
        "",
        "None",
        "",
        "</decisions>",
        "",
        "<specifics>",
        "## Specific Ideas",
        "",
        "- stale specific",
        "",
        "</specifics>",
        "",
        "<canonical_refs>",
        "## Canonical References",
        "",
        "- `.planning/PROJECT.md` - Project context source",
        "",
        "</canonical_refs>",
        "",
        "<code_context>",
        "## Existing Code Insights",
        "",
        "- stale code insight",
        "",
        "</code_context>",
        "",
        "<deferred>",
        "## Deferred Ideas",
        "",
        "- stale deferred note",
        "",
        "</deferred>",
      ].join("\n"),
    );
    writeFileSync(join(phaseDir, "02-DISCUSSION-LOG.md"), "# DISCUSSION LOG\n\nold log\n");
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Fresh assumption from analyzer
  - **Why this way:** latest repo state changed
  - **If wrong:** add fallback path
  - **Confidence:** Likely

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });

    const context = readFileSync(join(phaseDir, "02-CONTEXT.md"), "utf8");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(context).toContain("Fresh assumption from analyzer");
    expect(context).not.toContain("Stale assumption from older run");
  });

  it("research-gap rebuild clears stale assumption-derived sections before rebuilding", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          handle: {
            sessionId: "session-id",
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "session-id",
              status: "completed",
              summary: "done",
            }),
            captureOutput: vi.fn().mockResolvedValue({
              text: `## Assumptions

### Delivery
- **Assumption:** Old assumption
  - **Why this way:** old reason
  - **If wrong:** old fallback
  - **Confidence:** Confident

## Needs External Research
- verify vendor API rate limits
`,
            }),
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          handle: {
            sessionId: "session-id-2",
            waitForCompletion: vi.fn().mockResolvedValue({
              sessionId: "session-id-2",
              status: "completed",
              summary: "done",
            }),
            captureOutput: vi.fn().mockResolvedValue({
              text: `## Assumptions

### Delivery
- **Assumption:** New assumption
  - **Why this way:** new reason
  - **If wrong:** new fallback
  - **Confidence:** Confident

## Needs External Research
`,
            }),
          },
        },
      });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      auto: true,
      input: "Research complete.",
    });

    const context = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"),
      "utf8",
    );
    expect(context).toContain("New assumption");
    expect(context).not.toContain("Old assumption");
    expect(context).not.toContain("old reason");
    expect(context).not.toContain("old fallback");
  });

  it("loadPriorDiscussContext only reads earlier phases in descending order", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "0-bootstrap"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "3-future"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-CONTEXT.md"), "# prior\nA\n");
    writeFileSync(
      join(root, ".planning", "phases", "0-bootstrap", "00-CONTEXT.md"),
      "# older\nZ\n",
    );
    writeFileSync(join(root, ".planning", "phases", "3-future", "03-CONTEXT.md"), "# future\nB\n");
    const summary = loadPriorDiscussContext(root, "2");
    expect(summary).toContain("1-setup:");
    expect(summary).toContain("0-bootstrap:");
    expect(summary).not.toContain("3-future:");
  });

  it("loadPriorDiscussContext prefers DECISIONS-INDEX when present", async () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "DECISIONS-INDEX.md"),
      "# Decisions Index\n\n- D-01: canonical path\n- D-02: transport adapter\n",
    );
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-CONTEXT.md"), "# prior\nA\n");
    const summary = loadPriorDiscussContext(root, "2");
    expect(summary).toContain(".planning/DECISIONS-INDEX.md:");
    expect(summary).not.toContain("1-setup:");
  });

  it("loadPriorDiscussContext caps bounded window at three contexts", async () => {
    const root = createPlanningRoot();
    for (const phaseId of ["1-one", "2-two", "3-three", "4-four"]) {
      mkdirSync(join(root, ".planning", "phases", phaseId), { recursive: true });
    }
    writeFileSync(join(root, ".planning", "phases", "1-one", "01-CONTEXT.md"), "# one\n");
    writeFileSync(join(root, ".planning", "phases", "2-two", "02-CONTEXT.md"), "# two\n");
    writeFileSync(join(root, ".planning", "phases", "3-three", "03-CONTEXT.md"), "# three\n");
    writeFileSync(join(root, ".planning", "phases", "4-four", "04-CONTEXT.md"), "# four\n");
    const summary = loadPriorDiscussContext(root, "5");
    expect(summary).toContain("4-four:");
    expect(summary).toContain("3-three:");
    expect(summary).toContain("2-two:");
    expect(summary).not.toContain("1-one:");
  });

  it("discuss checkpoint stores area progress and question history for resume", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    const checkpoint = JSON.parse(
      readFileSync(join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as {
      stage: string;
      areasCompleted: string[];
      areasRemaining: string[];
      areaQuestions: Record<string, string[]>;
      promptOptions: string[];
    };
    expect(checkpoint.stage).toBe("existing-context");
    expect(checkpoint.areasCompleted).toEqual([]);
    expect(checkpoint.areasRemaining).toEqual(expect.arrayContaining(["Implementation approach"]));
    expect(checkpoint.promptOptions).toEqual(
      expect.arrayContaining([
        "Use existing context",
        "View context summary",
        "Skip prior context",
      ]),
    );
  });

  it("assumptions resume does not rerun analyzer or duplicate draft", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Technical Approach
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
- none
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    expect(spawn).toHaveBeenCalledTimes(1);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    const context = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"),
      "utf8",
    );
    expect(context).toContain("Reuse existing service layer (Likely)");
  });

  it("assumptions auto does not inject discuss default decisions", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      auto: true,
    });
    const context = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"),
      "utf8",
    );
    expect(context).not.toContain("- none");
    expect(context).not.toContain(
      "Default to existing project patterns for implementation approach.",
    );
    expect(context).not.toContain("Default to existing project patterns for canonical references.");
  });

  it("assumptions mode preserves manual confirmation without explicit auto", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Confident

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
    const phaseDir = join(root, ".planning", "phases", "2-build");
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(true);
    expect(existsSync(join(phaseDir, "02-CONTEXT.md"))).toBe(false);
  });

  it("resume honors persisted checkpoint mode over current config", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });
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
          workflow: { discuss_mode: "discuss" },
        },
        null,
        2,
      )}\n`,
    );
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    const context = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"),
      "utf8",
    );
    expect(context).toContain("Reuse existing service layer (Likely)");
  });

  it("discuss-phase blocks only on phase-local continue-here with blocking rows", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    writeFileSync(
      join(root, ".continue-here.md"),
      "| Requirement | Status | Blocking Issue |\n| --- | --- | --- |\n| R1 | open | fix phase 1 |\n",
    );
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    expect(existsSync(join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"))).toBe(true);

    writeFileSync(
      join(root, ".planning", "phases", "2-build", ".continue-here.md"),
      "| Requirement | Status | Blocking Issue |\n| --- | --- | --- |\n| R2 | blocked | unresolved migration |\n",
    );
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Blocking preflight: resolve .continue-here.md before /gsd discuss-phase. Acknowledge or resume pending work there first.",
      "warning",
    );
  });

  it("continue-here parser blocks on upstream Critical Anti-Patterns severity=blocking rows", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "2-build", ".continue-here.md"),
      [
        "## Critical Anti-Patterns",
        "",
        "| anti_pattern | why_it_hurts | prevention | severity |",
        "| --- | --- | --- | --- |",
        "| skip migration ordering | breaks data flow | apply schema first | blocking |",
      ].join("\n"),
    );

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Blocking preflight: resolve .continue-here.md before /gsd discuss-phase. Acknowledge or resume pending work there first.",
      "warning",
    );
    expect(existsSync(join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"))).toBe(false);
  });

  it("continue-here parser ignores unrelated markdown tables", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "phases", "2-build", ".continue-here.md"),
      "| Foo | Bar | Baz |\n| --- | --- | --- |\n| x | y | z |\n",
    );
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", auto: true });
    expect(existsSync(join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"))).toBe(true);
  });

  it("scoutDiscussCodebase selects quality docs for quality phase heuristics", async () => {
    const root = createPlanningRoot();
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      `# Roadmap: Demo

### Phase 1: Setup
**Goal**: Establish project baseline

Plans:
- [ ] 01-01: Create config

### Phase 2: Quality Sweep
**Goal**: Improve testing quality and validation coverage

Plans:
- [ ] 02-01: Tighten tests
`,
    );
    mkdirSync(join(root, ".planning", "codebase"), { recursive: true });
    for (const name of [
      "STACK.md",
      "INTEGRATIONS.md",
      "ARCHITECTURE.md",
      "STRUCTURE.md",
      "CONVENTIONS.md",
      "TESTING.md",
      "CONCERNS.md",
    ]) {
      writeFileSync(join(root, ".planning", "codebase", name), `# ${name}\n\nbody\nline2\nline3\n`);
    }
    const summary = scoutDiscussCodebase(root, "2");
    expect(summary).toContain(".planning/codebase/TESTING.md:");
    expect(summary).toContain(".planning/codebase/CONVENTIONS.md:");
  });

  it("assumptions analyzer rejects malformed incomplete blocks", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await expect(handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" })).rejects.toThrow(
      "Assumptions analyzer output malformed",
    );
  });

  it("assumptions analyzer rejects empty parsed assumption set on fresh run", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

## Needs External Research
- none
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await expect(handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" })).rejects.toThrow(
      "Assumptions analyzer returned zero assumptions",
    );
  });

  it("cli assumptions flag previews without artifact writes or state mutation", async () => {
    const root = createPlanningRoot();
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      assumptions: true,
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Assumptions preview"),
      "info",
    );
    expect(existsSync(join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"))).toBe(false);
    expect(
      existsSync(join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json")),
    ).toBe(false);
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain("current_phase: 1");
  });

  it("explicit assumptions preview overrides persisted artifact checkpoint route", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const phaseDir = join(root, ".planning", "phases", "2-build");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(
      join(phaseDir, "DISCUSS-CHECKPOINT.json"),
      `${JSON.stringify(
        {
          phase: "2",
          mode: "assumptions",
          route: "assumptions-artifact",
          all: false,
          auto: false,
          chain: false,
          text: false,
          stage: "final-loop",
          pendingPrompt: "persisted artifact route",
          promptOptions: ["Confirm assumptions"],
          priorContextSummary: "persisted",
          scoutSummary: "persisted",
          existingContextSummary: "persisted",
          areaQuestions: {},
          areaSelections: {},
          areasCompleted: [],
          areasRemaining: [],
          assumptionsAutoReady: false,
          assumptionsResearchGaps: [],
          deferredIdeas: [],
          canonicalReferences: [],
          draft: {
            phaseBoundary: "Phase 2: Build",
            implementationDecisions: [],
            discretionAreas: [],
            canonicalReferences: [],
            existingCodeInsights: [],
            specificIdeas: [],
            deferredIdeas: [],
            discussionLog: [],
          },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    const before = readFileSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"), "utf8");
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", assumptions: true });
    expect(readFileSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"), "utf8")).toBe(before);
    expect(existsSync(join(phaseDir, "02-CONTEXT.md"))).toBe(false);
    expect(readFileSync(join(root, ".planning", "STATE.md"), "utf8")).toContain("current_phase: 1");
  });

  it("assumptions refine path captures real correction input", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createInteractiveContext(root, {
      selects: ["Refine assumptions", "Technical Approach"],
      inputs: ["Switch to direct endpoint adapter"],
    });
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Technical Approach
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });

    const context = readFileSync(
      join(root, ".planning", "phases", "2-build", "02-CONTEXT.md"),
      "utf8",
    );
    expect(context).toContain("Switch to direct endpoint adapter");
    expect(context).not.toContain("Reuse existing service layer (Likely)");
  });

  it("text mode assumptions review can confirm artifact without TUI", async () => {
    const root = createPlanningRoot();
    setDiscussModeAssumptions(root);
    const ctx = createContext(root);
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Reuse existing service layer
  - **Why this way:** src/shared/api.ts already handles transport
  - **If wrong:** New endpoint wiring required
  - **Confidence:** Likely

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      text: true,
      input: "Confirm assumptions",
    });

    const phaseDir = join(root, ".planning", "phases", "2-build");
    expect(existsSync(join(phaseDir, "DISCUSS-CHECKPOINT.json"))).toBe(false);
    expect(readFileSync(join(phaseDir, "02-CONTEXT.md"), "utf8")).toContain(
      "Reuse existing service layer (Likely)",
    );
  });

  it("assumptions preview recomputes fresh analyzer output instead of replaying stale context", async () => {
    const root = createPlanningRoot();
    const phaseDir = join(root, ".planning", "phases", "2-build");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(
      join(phaseDir, "02-CONTEXT.md"),
      [
        "# CONTEXT",
        "",
        "<domain>",
        "## Phase Boundary",
        "",
        "Phase 2: Build",
        "",
        "</domain>",
        "",
        "<decisions>",
        "## Implementation Decisions",
        "",
        "### Delivery",
        "",
        "- **D-01:** Stale historical assumption",
        "",
        "### Claude's Discretion",
        "",
        "None",
        "",
        "</decisions>",
        "",
        "<specifics>",
        "## Specific Ideas",
        "",
        "None",
        "",
        "</specifics>",
        "",
        "<canonical_refs>",
        "## Canonical References",
        "",
        "- `.planning/PROJECT.md` - Project context source",
        "",
        "</canonical_refs>",
        "",
        "<code_context>",
        "## Existing Code Insights",
        "",
        "- stale insight",
        "",
        "</code_context>",
        "",
        "<deferred>",
        "## Deferred Ideas",
        "",
        "- stale deferred",
        "",
        "</deferred>",
      ].join("\n"),
    );
    const ctx = createContext(root) as ExtensionCommandContext & {
      ui: ExtensionCommandContext["ui"] & { notify: ReturnType<typeof vi.fn> };
    };
    const spawn = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        handle: {
          sessionId: "session-id",
          waitForCompletion: vi.fn().mockResolvedValue({
            sessionId: "session-id",
            status: "completed",
            summary: "done",
          }),
          captureOutput: vi.fn().mockResolvedValue({
            text: `## Assumptions

### Delivery
- **Assumption:** Fresh preview assumption
  - **Why this way:** analyzer reran from current repo state
  - **If wrong:** add fallback
  - **Confidence:** Confident

## Needs External Research
`,
          }),
        },
      },
    });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", assumptions: true });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Fresh preview assumption"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Stale historical assumption"),
      "info",
    );
    expect(readFileSync(join(phaseDir, "02-CONTEXT.md"), "utf8")).toContain(
      "Stale historical assumption",
    );
  });

  it("interactive default discuss presents full gray area list", async () => {
    const root = createPlanningRoot();
    const ctx = createInteractiveContext(root, {
      selects: ["Skip prior context", undefined],
    });

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });

    const checkpoint = JSON.parse(
      readFileSync(join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as { stage: string; promptOptions: string[] };
    expect(checkpoint.stage).toBe("gray-area-selection");
    expect(checkpoint.promptOptions).toEqual(
      expect.arrayContaining([
        "Implementation approach",
        "Canonical references",
        "Risks and deferrals",
      ]),
    );
  });

  it("text mode changes prompt rendering and bypasses interactive picker", async () => {
    const root = createPlanningRoot();
    const ctx = createInteractiveContext(root);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", text: true });

    expect(ctx.ui.select).not.toHaveBeenCalled();
    const checkpoint = JSON.parse(
      readFileSync(join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as { pendingPrompt: string; promptOptions: string[]; text: boolean };
    expect(checkpoint.text).toBe(true);
    expect(checkpoint.promptOptions).toEqual([]);
    expect(checkpoint.pendingPrompt).toContain("Reply in plain text");
  });

  it("text mode resume consumes plain-text selection reply", async () => {
    const root = createPlanningRoot();
    const ctx = createInteractiveContext(root);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", text: true });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      text: true,
      input: "Skip prior context",
    });

    const checkpoint = JSON.parse(
      readFileSync(join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as { stage: string; grayAreaAnalysis?: string };
    expect(checkpoint.stage).toBe("gray-area-selection");
    expect(checkpoint.grayAreaAnalysis).toContain("Default discuss");
  });

  it("text mode resume consumes numeric plain-text selection reply", async () => {
    const root = createPlanningRoot();
    const ctx = createInteractiveContext(root);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", text: true });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      text: true,
      input: "3",
    });

    const checkpoint = JSON.parse(
      readFileSync(join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as { stage: string; draft: { discussionLog: string[] } };
    expect(checkpoint.stage).toBe("gray-area-selection");
    expect(checkpoint.draft.discussionLog).toContain("Existing context branch: Skip prior context");
  });

  it("text mode resume consumes freeform answer input", async () => {
    const root = createPlanningRoot();
    const ctx = createInteractiveContext(root);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2", text: true });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      text: true,
      input: "Skip prior context",
    });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      text: true,
      input: "Implementation approach",
    });
    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, {
      phase: "2",
      text: true,
      input: "Use event-driven adapter",
    });

    const checkpoint = JSON.parse(
      readFileSync(join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as { draft: { discussionLog: string[] }; stage: string };
    expect(checkpoint.draft.discussionLog).toContain(
      "Implementation approach: Use event-driven adapter",
    );
    expect(checkpoint.stage).toBe("area-question");
  });

  it("config text_mode enables text-mode discuss prompts", async () => {
    const root = createPlanningRoot();
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
          workflow: { text_mode: true },
        },
        null,
        2,
      )}\n`,
    );
    const ctx = createInteractiveContext(root);

    await handleGsdDiscussPhase({} as ExtensionAPI, ctx, { phase: "2" });

    expect(ctx.ui.select).not.toHaveBeenCalled();
    const checkpoint = JSON.parse(
      readFileSync(join(root, ".planning", "phases", "2-build", "DISCUSS-CHECKPOINT.json"), "utf8"),
    ) as { pendingPrompt: string; text: boolean };
    expect(checkpoint.text).toBe(true);
    expect(checkpoint.pendingPrompt).toContain("Reply in plain text");
  });

  it("validate-phase launches workflow foundation for explicit phase", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdValidatePhase(pi, ctx, { phase: "2" }, "validate-phase 2");
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd validate-phase 2"',
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "commands/gsd/validate-phase.md",
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "workflows/validate-phase.md",
    );
  });

  it("validate-phase omitted phase prefers last completed local phase", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdValidatePhase(pi, ctx, {}, "validate-phase");
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd validate-phase 2"',
    );
  });

  it("validate-phase omitted phase skips partially executed higher phase", async () => {
    const root = createPlanningRoot();
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
- [ ] 02-02: Finish feature
`,
    );
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-01-SUMMARY.md"), "done\n");
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdValidatePhase(pi, ctx, {}, "validate-phase");
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd validate-phase 1"',
    );
  });

  it("validate-phase omitted phase ignores stale completed phase dirs outside roadmap", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "phases", "2-build"), { recursive: true });
    mkdirSync(join(root, ".planning", "phases", "9-stale"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "2-build", "02-01-SUMMARY.md"), "done\n");
    writeFileSync(join(root, ".planning", "phases", "9-stale", "09-01-SUMMARY.md"), "done\n");
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdValidatePhase(pi, ctx, {}, "validate-phase");
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd validate-phase 2"',
    );
  });

  it("validate-phase fails closed when no executed local phase exists", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdValidatePhase(pi, ctx, {}, "validate-phase");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Cannot run /gsd validate-phase: no completed local phase found. Need phase with at least one SUMMARY.md artifact.",
      "warning",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("verify-work launches workflow foundation instead of native artifact path", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdVerifyWork(pi, ctx, {}, "verify-work 1");
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd verify-work 1"',
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "commands/gsd/verify-work.md",
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "workflows/verify-work.md",
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "Do not call local native `orchestrateVerifyWork()` path",
    );
  });

  it("secure-phase launches workflow foundation", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);
    await handleGsdSecurePhase(pi, ctx, {}, "secure-phase 1");
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'Launch native GSD workflow for "/gsd secure-phase 1"',
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "commands/gsd/secure-phase.md",
    );
    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "workflows/secure-phase.md",
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
    const prompt = String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(prompt).toContain('Launch native GSD workflow for "/gsd milestone-summary v1.0"');
    expect(prompt).toContain(
      "Scope artifact reads and git stats to requested milestone only instead of concatenating every phase artifact or commit in repo.",
    );
    expect(prompt).toContain(
      "For archived milestones, read phase artifacts from `.planning/milestones/vX.Y-phases/` when `complete-milestone` moved them there.",
    );
    expect(prompt).toContain(
      "Do not leave `STATE.md` dirty after report generation unless final user-visible output explicitly includes coordinated state mutation.",
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

  it("debug continue rejects missing slug before launch", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "continue" });

    expect(ctx.ui.notify).toHaveBeenCalledWith("Missing debug session slug", "warning");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("debug continue rejects unknown slug before launch", async () => {
    const root = createPlanningRoot();
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "continue", slug: "missing-slug" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No active debug session found with slug: missing-slug. Check /gsd debug list for active sessions.",
      "warning",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("bare debug gates on active sessions instead of launching new workflow", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "debug"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "debug", "auth-token-null.md"),
      [
        "---",
        "status: investigating",
        "trigger: auth fails",
        "created: 2026-04-11",
        "updated: 2026-04-12",
        "---",
        "",
        "## Current Focus",
        "",
        "- hypothesis: token parse broken",
        "- next_action: add logging",
      ].join("\n"),
    );
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "start" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Active debug sessions"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run /gsd debug continue <slug> to resume or /gsd debug <issue description> to start new.",
      ),
      "info",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("debug continue preserves resume workflow launch when slug exists", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "debug"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "debug", "auth-token-null.md"),
      [
        "---",
        "status: investigating",
        "trigger: auth fails",
        "created: 2026-04-11",
        "updated: 2026-04-12",
        "---",
        "",
        "## Current Focus",
        "",
        "- hypothesis: token parse broken",
        "- next_action: add logging",
      ].join("\n"),
    );
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "continue", slug: "auth-token-null" });

    expect(String((pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      "Continue `/gsd debug` in this visible workflow session.",
    );
  });

  it("debug continue rejects resolved-only slug before launch", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "debug", "resolved"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "debug", "resolved", "auth-token-null.md"),
      [
        "---",
        "slug: auth-token-null",
        "status: resolved",
        "trigger: auth fails",
        "created: 2026-04-11",
        "updated: 2026-04-12",
        "---",
        "",
        "## Current Focus",
        "",
        "- hypothesis: token parse broken",
        "- next_action: add logging",
      ].join("\n"),
    );
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "continue", slug: "auth-token-null" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No active debug session found with slug: auth-token-null. Check /gsd debug list for active sessions.",
      "warning",
    );
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("debug status parses bullet current focus fields", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "debug"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "debug", "parser-crash.md"),
      [
        "---",
        "status: investigating",
        "trigger: parser crash",
        "created: 2026-05-06",
        "updated: 2026-05-06T00:25:00Z",
        "---",
        "",
        "## Current Focus",
        "",
        "- hypothesis: schema too strict",
        "- next_action: widen frontmatter schema",
      ].join("\n"),
    );
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "status", slug: "parser-crash" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("hypothesis=schema too strict"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("next_action=widen frontmatter schema"),
      "info",
    );
  });

  it("debug status parses plain current focus fields", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "debug"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "debug", "parser-crash.md"),
      [
        "---",
        "status: investigating",
        "trigger: parser crash",
        "created: 2026-05-06",
        "updated: 2026-05-06T00:25:00Z",
        "---",
        "",
        "## Current Focus",
        "",
        "hypothesis: schema too strict",
        "next_action: widen frontmatter schema",
        "",
        "## Evidence Log",
        "",
        "- timestamp: 2026-05-06T00:30:00Z",
      ].join("\n"),
    );
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "status", slug: "parser-crash" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("hypothesis=schema too strict"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("next_action=widen frontmatter schema"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("timestamp=2026-05-06T00:30:00Z"),
      "info",
    );
  });

  it("debug status counts eliminated hypotheses only from eliminated section", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "debug"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "debug", "parser-crash.md"),
      [
        "---",
        "status: investigating",
        "trigger: parser crash",
        "created: 2026-05-06",
        "updated: 2026-05-06T00:25:00Z",
        "---",
        "",
        "## Current Focus",
        "",
        "- hypothesis: schema too strict",
        "- next_action: widen frontmatter schema",
        "",
        "## Eliminated",
        "",
        "- hypothesis: bad cache state",
      ].join("\n"),
    );
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "status", slug: "parser-crash" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("eliminated=1"), "info");
  });

  it("debug status shows richer output for resolved sessions", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "debug", "resolved"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "debug", "resolved", "auth-fix.md"),
      [
        "---",
        "slug: auth-fix",
        "status: resolved",
        "trigger: auth fails",
        "goal: find_and_fix",
        "created: 2026-05-01T00:00:00Z",
        "updated: 2026-05-02T00:00:00Z",
        "---",
        "",
        "## Current Focus",
        "",
        "- hypothesis: null token path fixed",
        "- next_action: verify production deploy",
        "",
        "## Resolution",
        "",
        "root_cause: token null guard skipped resolved path",
        "fix: restore resolved-session branch before auth check",
        "verification: vitest auth debug flow passes",
        "files_changed:",
        "- src/auth/session.ts",
        "- test/auth/session.test.ts",
      ].join("\n"),
    );
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "status", slug: "auth-fix" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("trigger=auth fails"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("goal=find_and_fix"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("created=2026-05-01T00:00:00Z"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("updated=2026-05-02T00:00:00Z"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("root_cause=token null guard skipped resolved path"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("fix=restore resolved-session branch before auth check"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("verification=vitest auth debug flow passes"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("files_changed=src/auth/session.ts,test/auth/session.test.ts"),
      "info",
    );
  });

  it("debug status shows inline template files_changed values for resolved sessions", async () => {
    const root = createPlanningRoot();
    mkdirSync(join(root, ".planning", "debug", "resolved"), { recursive: true });
    writeFileSync(
      join(root, ".planning", "debug", "resolved", "auth-inline-fix.md"),
      [
        "---",
        "slug: auth-inline-fix",
        "status: resolved",
        "trigger: auth fails",
        "goal: find_and_fix",
        "created: 2026-05-01T00:00:00Z",
        "updated: 2026-05-02T00:00:00Z",
        "---",
        "",
        "## Current Focus",
        "",
        "- hypothesis: null token path fixed",
        "- next_action: verify production deploy",
        "",
        "## Resolution",
        "",
        "root_cause: token null guard skipped resolved path",
        "fix: restore resolved-session branch before auth check",
        "verification: vitest auth debug flow passes",
        "files_changed: [src/auth/session.ts, test/auth/session.test.ts]",
      ].join("\n"),
    );
    const pi = createPi();
    const ctx = createContext(root, pi);

    await handleGsdDebug(pi, ctx, { debugAction: "status", slug: "auth-inline-fix" });

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("files_changed=src/auth/session.ts,test/auth/session.test.ts"),
      "info",
    );
  });
});
