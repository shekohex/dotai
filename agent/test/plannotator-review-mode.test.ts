import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const spawnMock = vi.fn();
const disposeMock = vi.fn();

vi.mock("../src/subagent-sdk/index.js", () => ({
  buildLaunchCommand: vi.fn(),
  TmuxAdapter: class {},
  createSubagentSDK: vi.fn(() => ({
    spawn: spawnMock,
    dispose: disposeMock,
  })),
}));

vi.mock("../src/extensions/review/guidelines.js", () => ({
  loadProjectReviewGuidelines: vi.fn(async () => "Prefer tests first."),
}));

describe("plannotator review mode bridge", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    disposeMock.mockReset();
  });

  function createContext(customInstructions?: string): ExtensionContext {
    return {
      cwd: process.cwd(),
      hasUI: false,
      ui: {
        setWidget() {},
        notify() {},
        onTerminalInput(handler: (data: string) => unknown) {
          return handler;
        },
      },
      sessionManager: {
        getEntries: () =>
          customInstructions === undefined
            ? []
            : [
                {
                  type: "custom",
                  customType: "review-settings",
                  data: { customInstructions },
                },
              ],
        getBranch: () => [],
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
      },
      shutdown() {},
    } as unknown as ExtensionContext;
  }

  it("maps plannotator diff context to shared review targets", async () => {
    const module = await import("../src/extensions/plannotator/server/review-mode-launch.js");

    expect(
      module.createReviewTarget({
        pi: {} as never,
        ctx: createContext(),
        cwd: process.cwd(),
        currentPatch: "diff --git a/a b/a",
        currentDiffType: "uncommitted",
        currentBase: "main",
        currentPrDiffScope: "stack",
      }),
    ).toEqual({ type: "uncommitted" });

    expect(
      module.createReviewTarget({
        pi: {} as never,
        ctx: createContext(),
        cwd: process.cwd(),
        currentPatch: "diff --git a/a b/a",
        currentDiffType: "branch",
        currentBase: "develop",
        currentPrDiffScope: "stack",
      }),
    ).toEqual({ type: "baseBranch", branch: "develop" });

    expect(
      module.createReviewTarget({
        pi: {} as never,
        ctx: createContext(),
        cwd: process.cwd(),
        currentPatch: "diff --git a/a b/a",
        currentDiffType: "committed",
        currentBase: "main",
        currentPrDiffScope: "stack",
      }),
    ).toBeNull();

    expect(
      module.createReviewTarget({
        pi: {} as never,
        ctx: createContext(),
        cwd: process.cwd(),
        currentPatch: "diff --git a/a b/a",
        currentDiffType: "uncommitted",
        currentBase: "main",
        currentPrDiffScope: "layer",
        prMetadata: {
          platform: "github",
          number: 42,
          title: "Fix race condition in review launcher",
          baseBranch: "main",
          url: "https://example.com/pr/42",
        },
      }),
    ).toEqual({
      type: "pullRequest",
      prNumber: 42,
      baseBranch: "main",
      title: "Fix race condition in review launcher",
    });

    expect(
      module.createReviewTarget({
        pi: {} as never,
        ctx: createContext(),
        cwd: process.cwd(),
        currentPatch: "diff --git a/a b/a",
        currentDiffType: "branch",
        currentBase: "main",
        currentPrDiffScope: "full-stack",
        prMetadata: {
          platform: "github",
          number: 42,
          title: "Fix race condition in review launcher",
          baseBranch: "main",
          url: "https://example.com/pr/42",
        },
      }),
    ).toEqual({ type: "baseBranch", branch: "main" });
  });

  it("builds shared review-mode task prompt with custom instructions and guidelines", async () => {
    const module = await import("../src/extensions/plannotator/server/review-mode-launch.js");

    const task = await module.buildReviewTask({
      pi: {} as never,
      ctx: createContext("Focus on migrations."),
      cwd: process.cwd(),
      currentPatch: "diff --git a/a b/a",
      currentDiffType: "uncommitted",
      currentBase: "main",
      currentPrDiffScope: "stack",
    });

    expect(task).toContain("Please perform a code review using the built-in review mode.");
    expect(task).toContain("Review target:");
    expect(task).toContain("current changes");
    expect(task).toContain("Shared custom review instructions:");
    expect(task).toContain("Focus on migrations.");
    expect(task).toContain("Project review guidelines:");
    expect(task).toContain("Prefer tests first.");
    expect(task).toContain("Return structured output with:");
    expect(task).toContain("`findings`: array of conventional review comments");
    expect(task).toContain("Include worthwhile nits and conventional review-style suggestions");
  });

  it("launches subagent in canonical review mode with json schema output", async () => {
    spawnMock.mockResolvedValue({
      ok: true,
      value: {
        state: { sessionId: "child-1" },
        structured: {
          correctness: "Issues Found",
          explanation: "One bug found",
          confidence: 0.81,
          findings: [],
        },
      },
    });

    const module = await import("../src/extensions/plannotator/server/review-mode-launch.js");
    const context = createContext("Check edge cases.");

    const result = await module.launchReviewModeSubagent({
      pi: { exec: vi.fn() } as never,
      ctx: context,
      cwd: process.cwd(),
      currentPatch: "diff --git a/a b/a",
      currentDiffType: "uncommitted",
      currentBase: "main",
      currentPrDiffScope: "stack",
    });

    expect(result.structured.correctness).toBe("Issues Found");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [spawnInput, spawnCtx] = spawnMock.mock.calls[0] as [
      Record<string, unknown>,
      ExtensionContext,
    ];
    expect(spawnCtx).toBe(context);
    expect(spawnInput.mode).toBe("review");
    expect(spawnInput.name).toBe("review");
    expect(spawnInput.persisted).toBe(false);
    expect(spawnInput.completion).toBe(false);
    expect(spawnInput.outputFormat).toMatchObject({ type: "json_schema" });
    expect(String(spawnInput.task)).toContain("Check edge cases.");
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("maps structured review findings into plannotator annotations", async () => {
    const module = await import("../src/extensions/plannotator/server/review-agent-jobs.js");

    const annotations = module.toAnnotations(
      "agent-123",
      [
        "diff --git a/agent/src/app.ts b/agent/src/app.ts",
        "diff --git a/src/other.ts b/src/other.ts",
      ].join("\n"),
      {
        correctness: "Issues Found",
        explanation: "Mismatch found",
        confidence: 0.7,
        findings: [
          {
            filePath: "src/app.ts",
            lineStart: 10,
            lineEnd: 12,
            title: "Missing null guard before property access",
            text: "Potential bug.",
            severity: "important",
            reasoning: "Condition skips null check.",
          },
          {
            filePath: "src/other.ts",
            lineStart: 2,
            lineEnd: 2,
            title: "Simplify wording in helper name",
            text: "Nit.",
          },
        ],
      },
    );

    expect(annotations).toEqual([
      {
        source: "agent-123",
        filePath: "agent/src/app.ts",
        selectedText: "Missing null guard before property access",
        lineStart: 10,
        lineEnd: 12,
        comment:
          "[AI Review · IMPORTANT] Missing null guard before property access\n\nPotential bug.\n\nWhy: Condition skips null check.",
        author: "AI",
        title: "Missing null guard before property access",
        severity: "important",
        reasoning: "Condition skips null check.",
      },
      {
        source: "agent-123",
        filePath: "src/other.ts",
        selectedText: "Simplify wording in helper name",
        lineStart: 2,
        lineEnd: 2,
        comment: "[AI Review] Simplify wording in helper name\n\nNit.",
        author: "AI",
        title: "Simplify wording in helper name",
      },
    ]);
  });
});
