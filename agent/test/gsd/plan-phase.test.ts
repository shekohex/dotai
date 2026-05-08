import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { handleGsdPlanPhase } from "../../src/extensions/gsd/lifecycle/plan-phase.js";
import { setGsdSubagentSdkFactoryForTests } from "../../src/extensions/gsd/subagents.js";

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-gsd-plan-phase-"));
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
        workflow: { research: true },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, ".planning", "ROADMAP.md"),
    [
      "# Roadmap: Demo",
      "",
      "### Phase 1: Setup",
      "**Goal**: Establish project baseline",
      "**Requirements**: [REQ-01]",
      "**Plans**: 0 plans",
      "",
      "Plans:",
      "- [ ] 01-01: Create config",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, ".planning", "PROJECT.md"), "# Demo\n");
  writeFileSync(join(root, ".planning", "REQUIREMENTS.md"), "# Requirements\n");
  writeFileSync(
    join(root, ".planning", "STATE.md"),
    "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: \nstatus: Ready to plan\n",
  );
  return root;
}

function createContext(
  cwd: string,
  selectValues: Array<string | undefined> = [],
): ExtensionCommandContext {
  const selections = [...selectValues];
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
      select: vi.fn(async () => selections.shift()),
    },
    sessionManager: {
      getSessionId: () => "parent-session-id",
    },
  } as unknown as ExtensionCommandContext;
}

function createPi(): ExtensionAPI {
  return {} as ExtensionAPI;
}

function createSpawn(
  root: string,
  options?: {
    existingResearch?: boolean;
    failPatternMapper?: boolean;
    plannerWritesInvalidName?: boolean;
    plannerWritesInvalidFrontmatter?: boolean;
    plannerWritesEmptyMustHavesObject?: boolean;
    checkerApprovals?: boolean[];
  },
): ReturnType<typeof vi.fn> {
  if (options?.existingResearch === true) {
    mkdirSync(join(root, ".planning", "phases", "1-setup"), { recursive: true });
    writeFileSync(join(root, ".planning", "phases", "1-setup", "01-RESEARCH.md"), "# Research\n");
  }

  let plannerRun = 0;
  let checkerRun = 0;

  return vi
    .fn()
    .mockImplementation(
      async ({
        mode,
        outputFormat,
        task,
      }: {
        mode?: string;
        outputFormat?: { type?: string };
        task?: string;
      }) => {
        const taskText = String(task ?? "");
        const isPhaseTwo =
          taskText.includes("phase 2 Delivery") || taskText.includes("Phase 2 Delivery");
        const phaseDir = join(root, ".planning", "phases", isPhaseTwo ? "2-delivery" : "1-setup");
        const phasePrefix = isPhaseTwo ? "02" : "01";
        mkdirSync(phaseDir, { recursive: true });

        if (mode === "gsd-phase-researcher") {
          writeFileSync(join(phaseDir, `${phasePrefix}-RESEARCH.md`), "# Research\n\nDone\n");
          return {
            ok: true,
            value: {
              handle: {
                sessionId: "research-session",
                waitForCompletion: vi.fn().mockResolvedValue({
                  sessionId: "research-session",
                  status: "completed",
                  summary: "research done",
                }),
                captureOutput: vi.fn().mockResolvedValue({ text: "research done" }),
              },
            },
          };
        }

        if (mode === "gsd-pattern-mapper") {
          if (options?.failPatternMapper === true) {
            throw new Error("pattern mapper failed");
          }
          writeFileSync(join(phaseDir, `${phasePrefix}-PATTERNS.md`), "# Patterns\n\nDone\n");
          return {
            ok: true,
            value: {
              handle: {
                sessionId: "pattern-session",
                waitForCompletion: vi.fn().mockResolvedValue({
                  sessionId: "pattern-session",
                  status: "completed",
                  summary: "patterns done",
                }),
                captureOutput: vi.fn().mockResolvedValue({ text: "patterns done" }),
              },
            },
          };
        }

        if (mode === "gsd-planner" && outputFormat?.type === "json_schema") {
          plannerRun += 1;
          const canonicalPlanPath = join(phaseDir, `${phasePrefix}-01-PLAN.md`);
          const invalidNamePath = join(phaseDir, `${phasePrefix}-PLAN-01-foundation.md`);
          if (options?.plannerWritesInvalidName === true) {
            writeFileSync(
              invalidNamePath,
              `---\nphase: ${phasePrefix}\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: [works]\n---\n\n## Tasks\n\n### Task 1: Bad name\n`,
            );
          } else {
            writeFileSync(
              canonicalPlanPath,
              options?.plannerWritesInvalidFrontmatter === true
                ? "---\nphase: 02\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: [works]\n---\n\n## Tasks\n\n### Task 1: Broken\n"
                : options?.plannerWritesEmptyMustHavesObject === true
                  ? `---\nphase: ${phasePrefix}\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: {}\n---\n\n## Tasks\n\n### Task 1: Empty must haves\n\nDo it\n`
                  : `---\nphase: ${phasePrefix}\nplan: 01\ntype: implementation\nwave: 1\ndepends_on: []\nfiles_modified: []\nautonomous: true\nmust_haves: [works]\n---\n\n## Tasks\n\n### Task 1: Good\n\nDo it\n`,
            );
          }
          return {
            ok: true,
            value: {
              structured: {
                status: plannerRun === 1 ? "created" : "revised",
                summary: "planner done",
              },
            },
          };
        }

        if (mode === "gsd-plan-checker" && outputFormat?.type === "json_schema") {
          const approvals = options?.checkerApprovals ?? [true];
          const approved = approvals[Math.min(checkerRun, approvals.length - 1)] ?? false;
          checkerRun += 1;
          return {
            ok: true,
            value: {
              structured: {
                approved,
                summary: approved ? "approved" : "needs revision",
                issues: approved
                  ? []
                  : [
                      {
                        severity: "blocker",
                        description: "Missing dependency order",
                        fix_hint: "Revise task order",
                      },
                    ],
              },
            },
          };
        }

        throw new Error(`Unexpected mode ${String(mode)}`);
      },
    );
}

describe("gsd plan-phase slice 1", () => {
  afterEach(() => {
    setGsdSubagentSdkFactoryForTests(undefined);
    execFileSyncMock.mockReset();
  });

  it("research-only view exits before planner and checker", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { existingResearch: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    const ctx = createContext(root);

    await handleGsdPlanPhase(createPi(), ctx, {
      subcommand: "plan-phase",
      researchPhase: "1",
      view: true,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("# Research\n", "info");
  });

  it("research-only route asks how to handle existing artifact", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { existingResearch: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    const viewCtx = createContext(root, ["View existing research"]);

    await handleGsdPlanPhase(createPi(), viewCtx, {
      subcommand: "plan-phase",
      researchPhase: "1",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(viewCtx.ui.select).toHaveBeenCalled();
    expect(viewCtx.ui.notify).toHaveBeenCalledWith("# Research\n", "info");

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      researchPhase: "1",
      research: true,
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-phase-researcher")).toBe(true);
  });

  it("research-only route can skip existing artifact without viewing", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { existingResearch: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root, ["Skip"]), {
      subcommand: "plan-phase",
      researchPhase: "1",
    });

    expect(spawn).not.toHaveBeenCalled();
  });

  it("research-only route can regenerate existing artifact from chooser", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { existingResearch: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root, ["Regenerate research"]), {
      subcommand: "plan-phase",
      researchPhase: "1",
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-phase-researcher")).toBe(true);
  });

  it("research-only route without select UI warns instead of collapsing to view", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { existingResearch: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);
    const ctx = createContext(root);
    delete (ctx.ui as { select?: unknown }).select;

    await handleGsdPlanPhase(createPi(), ctx, {
      subcommand: "plan-phase",
      researchPhase: "1",
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Research artifact already exists:"),
      "warning",
    );
  });

  it("research-only view missing artifact fails clearly", async () => {
    const root = createRoot();
    const spawn = createSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        researchPhase: "1",
        view: true,
      }),
    ).rejects.toThrow(/Research artifact missing for --view/);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("normalizes padded explicit phase input for planning and research routes", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { existingResearch: true, checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "01",
    });

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      researchPhase: "01",
      view: true,
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-plan-checker")).toBe(true);
  });

  it("default route reuses existing research unless forced", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { existingResearch: true, checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "1",
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-phase-researcher")).toBe(false);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-pattern-mapper")).toBe(true);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-plan-checker")).toBe(true);
  });

  it("standard route feeds present phase artifacts into planner and checker required reading", async () => {
    const root = createRoot();
    const phaseDir = join(root, ".planning", "phases", "1-setup");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-CONTEXT.md"), "# Context\n");
    writeFileSync(join(phaseDir, "01-VALIDATION.md"), "# Validation\n");
    writeFileSync(join(phaseDir, "01-VERIFICATION.md"), "# Verification\n");
    writeFileSync(join(phaseDir, "01-UAT.md"), "# UAT\n");
    writeFileSync(join(phaseDir, "01-REVIEWS.md"), "# Reviews\n");
    writeFileSync(join(phaseDir, "01-UI-SPEC.md"), "# UI\n");
    const spawn = createSpawn(root, { existingResearch: true, checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "1",
    });

    const plannerTask = String(
      spawn.mock.calls.find((call) => call[0]?.mode === "gsd-planner")?.[0]?.task,
    );
    const checkerTask = String(
      spawn.mock.calls.find((call) => call[0]?.mode === "gsd-plan-checker")?.[0]?.task,
    );
    expect(plannerTask).toContain("01-CONTEXT.md");
    expect(plannerTask).toContain("01-UI-SPEC.md");
    expect(plannerTask).toContain("<phase_goal>Establish project baseline</phase_goal>");
    expect(plannerTask).toContain("<phase_requirement_ids>REQ-01</phase_requirement_ids>");
    expect(checkerTask).toContain("01-CONTEXT.md");
    expect(checkerTask).toContain("01-VERIFICATION.md");
    expect(checkerTask).toContain("01-UAT.md");
    expect(checkerTask).toContain("01-REVIEWS.md");
  });

  it("research route feeds present CONTEXT.md into researcher required reading", async () => {
    const root = createRoot();
    const phaseDir = join(root, ".planning", "phases", "1-setup");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-CONTEXT.md"), "# Context\n");
    const spawn = createSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      researchPhase: "1",
      research: true,
    });

    const researchTask = String(
      spawn.mock.calls.find((call) => call[0]?.mode === "gsd-phase-researcher")?.[0]?.task,
    );
    expect(researchTask).toContain("01-CONTEXT.md");
  });

  it("forced research reruns researcher", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { existingResearch: true, checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "1",
      research: true,
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-phase-researcher")).toBe(true);
  });

  it("skip-research bypasses researcher but still runs planner and checker", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "1",
      skipResearch: true,
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-phase-researcher")).toBe(false);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-pattern-mapper")).toBe(true);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-planner")).toBe(true);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-plan-checker")).toBe(true);
  });

  it("gaps route fails clearly when verification evidence missing", async () => {
    const root = createRoot();
    const spawn = createSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        phase: "1",
        gaps: true,
      }),
    ).rejects.toThrow(/Gap planning requires verification evidence/);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects mutually exclusive route flags", async () => {
    const root = createRoot();
    const spawn = createSpawn(root);
    const ctx = createContext(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), ctx, {
      subcommand: "plan-phase",
      researchPhase: "1",
      reviews: true,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd plan-phase route combination: --research-phase + --reviews. Choose exactly one route.",
      "warning",
    );
  });

  it("rejects gaps plus reviews route combination", async () => {
    const root = createRoot();
    const spawn = createSpawn(root);
    const ctx = createContext(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), ctx, {
      subcommand: "plan-phase",
      phase: "1",
      gaps: true,
      reviews: true,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Unsupported /gsd plan-phase route combination: --gaps + --reviews. Choose exactly one route.",
      "warning",
    );
  });

  it("gaps route skips research and reaches planner with gap context", async () => {
    const root = createRoot();
    const phaseDir = join(root, ".planning", "phases", "1-setup");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-VERIFICATION.md"), "# Verification\n");
    writeFileSync(join(phaseDir, "01-UAT.md"), "# UAT\n");
    const spawn = createSpawn(root, { checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "1",
      gaps: true,
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-phase-researcher")).toBe(false);
    const plannerTask = String(
      spawn.mock.calls.find((call) => call[0]?.mode === "gsd-planner")?.[0]?.task,
    );
    expect(plannerTask).toContain(
      "Route: gaps. Replan only to close documented verification or UAT gaps.",
    );
    expect(plannerTask).toContain("01-VERIFICATION.md");
    expect(plannerTask).toContain("01-UAT.md");
  });

  it("reviews route fails clearly when REVIEWS.md missing", async () => {
    const root = createRoot();
    const spawn = createSpawn(root);
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        phase: "1",
        reviews: true,
      }),
    ).rejects.toThrow(/Review planning requires 01-REVIEWS.md/);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("reviews route skips research and reaches planner with review context", async () => {
    const root = createRoot();
    const phaseDir = join(root, ".planning", "phases", "1-setup");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "01-REVIEWS.md"), "# Reviews\n");
    const spawn = createSpawn(root, { checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "1",
      reviews: true,
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-phase-researcher")).toBe(false);
    const plannerTask = String(
      spawn.mock.calls.find((call) => call[0]?.mode === "gsd-planner")?.[0]?.task,
    );
    expect(plannerTask).toContain("Route: reviews. Replan from reviews feedback in REVIEWS.md.");
    expect(plannerTask).toContain("01-REVIEWS.md");
  });

  it("pattern-mapper failure is non-blocking", async () => {
    const root = createRoot();
    const ctx = createContext(root);
    const spawn = createSpawn(root, { failPatternMapper: true, checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), ctx, {
      subcommand: "plan-phase",
      phase: "1",
      skipResearch: true,
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-pattern-mapper")).toBe(true);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-planner")).toBe(true);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-plan-checker")).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "Pattern mapping failed; continuing without PATTERNS.md: pattern mapper failed",
      ),
      "warning",
    );
    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    expect(state).toContain("status: Ready to execute");
  });

  it("malformed canonical plan filename fails before checker", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { plannerWritesInvalidName: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        phase: "1",
        skipResearch: true,
      }),
    ).rejects.toThrow(/non-canonical plan files/);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-plan-checker")).toBe(false);
  });

  it("malformed canonical frontmatter fails before checker", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { plannerWritesInvalidFrontmatter: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        phase: "1",
        skipResearch: true,
      }),
    ).rejects.toThrow(/mismatched frontmatter phase/);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-plan-checker")).toBe(false);
  });

  it("checker failure triggers planner revision loop max 3 attempts", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { checkerApprovals: [false, false, false] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        phase: "1",
        skipResearch: true,
      }),
    ).rejects.toThrow("Plan checker failed after 3 attempts.");

    expect(spawn.mock.calls.filter((call) => call[0]?.mode === "gsd-planner")).toHaveLength(3);
    expect(spawn.mock.calls.filter((call) => call[0]?.mode === "gsd-plan-checker")).toHaveLength(3);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("skip-verify still requires canonical plan validation", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { plannerWritesInvalidName: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        phase: "1",
        skipVerify: true,
        skipResearch: true,
      }),
    ).rejects.toThrow(/non-canonical plan files/);
    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-plan-checker")).toBe(false);
  });

  it("rejects empty object must_haves during canonical validation", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { plannerWritesEmptyMustHavesObject: true });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        phase: "1",
        skipVerify: true,
        skipResearch: true,
      }),
    ).rejects.toThrow(/missing must_haves/);
  });

  it("success path updates state and roadmap once", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "1",
    });

    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    const roadmap = readFileSync(join(root, ".planning", "ROADMAP.md"), "utf8");
    expect(state).toContain("current_phase: 1");
    expect(state).toContain("current_plan: 01-01");
    expect(state).toContain("status: Ready to execute");
    expect(roadmap.match(/\*\*Plans\*\*: 1 plan/gmu)).toHaveLength(1);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["roadmap", "annotate-dependencies", "1"]),
    );
    expect(execFileSyncMock.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        "gap-analysis",
        "--phase-dir",
        join(root, ".planning", "phases", "1-setup"),
      ]),
    );
  });

  it("success path runs helper stage after skip-verify too", async () => {
    const root = createRoot();
    const spawn = createSpawn(root, { checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      phase: "1",
      skipVerify: true,
      skipResearch: true,
    });

    expect(spawn.mock.calls.some((call) => call[0]?.mode === "gsd-plan-checker")).toBe(false);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("failure path does not advance state", async () => {
    const root = createRoot();
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: 99-99\nstatus: Ready to execute\n",
    );
    const spawn = createSpawn(root, { checkerApprovals: [false, false, false] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await expect(
      handleGsdPlanPhase(createPi(), createContext(root), {
        subcommand: "plan-phase",
        phase: "1",
        skipResearch: true,
      }),
    ).rejects.toThrow("Plan checker failed after 3 attempts.");

    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    expect(state).toContain("current_phase: 1");
    expect(state).toContain("current_plan: ");
    expect(state).not.toContain("current_plan: 99-99");
    expect(state).toContain("status: Planning blocked");
    expect(state).not.toContain("current_plan: 01-01");
    expect(state).not.toContain("status: Ready to execute");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("omitted phase selects next unplanned phase before current state fallback", async () => {
    const root = createRoot();
    writeFileSync(
      join(root, ".planning", "ROADMAP.md"),
      [
        "# Roadmap: Demo",
        "",
        "### Phase 1: Setup",
        "**Goal**: Establish project baseline",
        "**Requirements**: [REQ-01]",
        "**Plans**: 1 plan",
        "",
        "Plans:",
        "- [x] 01-01: Create config",
        "",
        "### Phase 2: Delivery",
        "**Goal**: Ship value",
        "**Requirements**: [REQ-02]",
        "**Plans**: 0 plans",
        "",
        "Plans:",
        "- [ ] 02-01: Ship value",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, ".planning", "STATE.md"),
      "current_phase: 1\ncurrent_phase_name: Setup\ncurrent_plan: \nstatus: Ready to plan\n",
    );
    const spawn = createSpawn(root, { checkerApprovals: [true] });
    setGsdSubagentSdkFactoryForTests(() => ({ spawn }) as never);

    await handleGsdPlanPhase(createPi(), createContext(root), {
      subcommand: "plan-phase",
      skipResearch: true,
    });

    const plannerTask = String(
      spawn.mock.calls.find((call) => call[0]?.mode === "gsd-planner")?.[0]?.task,
    );
    expect(plannerTask).toContain("Plan phase 2 Delivery.");
    expect(plannerTask).toContain("using 02-{NN}-PLAN.md");
    const state = readFileSync(join(root, ".planning", "STATE.md"), "utf8");
    expect(state).toContain("current_phase: 2");
    expect(state).toContain("current_phase_name: Delivery");
    expect(state).toContain("current_plan: 02-01");
    expect(readFileSync(join(root, ".planning", "ROADMAP.md"), "utf8")).toContain(
      "### Phase 2: Delivery",
    );
    expect(execFileSyncMock.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining([
        "gap-analysis",
        "--phase-dir",
        join(root, ".planning", "phases", "2-delivery"),
      ]),
    );
  });
});
