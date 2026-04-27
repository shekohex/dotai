import { expect, test } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";

import {
  buildReviewHandoffPrompt,
  createReviewExtension,
  isReviewStateActiveOnBranch,
  loadProjectReviewGuidelines,
  parsePrReference,
  parseReviewPaths,
} from "../src/extensions/review.ts";
import type { MuxAdapter, PaneSubmitMode } from "../src/subagent-sdk/mux.ts";

const TEST_TIMEOUT_MS = 15_000;
const execFile = promisify(execFileCallback);

const timedTest: typeof test = ((name: string, fn: (...args: any[]) => any) =>
  test(name, { timeout: TEST_TIMEOUT_MS }, fn)) as typeof test;

class HarnessMuxAdapter implements MuxAdapter {
  readonly backend = "tmux";
  readonly created: Array<{
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
    paneId: string;
  }> = [];
  readonly sent: Array<{ paneId: string; text: string; submitMode?: PaneSubmitMode }> = [];
  readonly killed: string[] = [];
  readonly existingPanes = new Set<string>();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createPane(options: {
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
  }): Promise<{ paneId: string }> {
    const paneId = `%${this.created.length + 1}`;
    this.created.push({ ...options, paneId });
    this.existingPanes.add(paneId);
    return { paneId };
  }

  async sendText(paneId: string, text: string, submitMode?: PaneSubmitMode): Promise<void> {
    this.sent.push({ paneId, text, submitMode });
  }

  async paneExists(paneId: string): Promise<boolean> {
    return this.existingPanes.has(paneId);
  }

  async killPane(paneId: string): Promise<void> {
    this.killed.push(paneId);
    this.existingPanes.delete(paneId);
  }

  async capturePane(): Promise<{ text: string }> {
    return { text: "" };
  }
}

class FailingMuxAdapter extends HarnessMuxAdapter {
  override async createPane(_options: {
    cwd: string;
    title: string;
    command: string;
    target: "pane" | "window";
  }): Promise<{ paneId: string }> {
    throw new Error("mux create failed");
  }
}

function patchHarnessAgent(testSession: TestSession): void {
  const agent = testSession.session.agent as {
    state: { tools: unknown[] };
    setTools?: (tools: unknown[]) => void;
  };
  agent.setTools ??= (tools: unknown[]) => {
    agent.state.tools = tools;
  };
}

async function initGitRepo(cwd: string): Promise<void> {
  await execFile("git", ["init", "-b", "main"], { cwd });
  await execFile("git", ["config", "user.name", "Review Test"], { cwd });
  await execFile("git", ["config", "user.email", "review-test@example.com"], { cwd });
}

async function commitFile(
  cwd: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(cwd, relativePath), content, "utf8");
  await execFile("git", ["add", relativePath], { cwd });
  await execFile("git", ["commit", "-m", message], { cwd });
}

async function writeReviewModesFile(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "modes.json"),
    `${JSON.stringify(
      {
        version: 1,
        modes: {
          review: {
            tools: ["read"],
            autoExit: true,
            tmuxTarget: "window",
            systemPrompt: "Review only",
            systemPromptMode: "append",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeFakeGh(cwd: string): Promise<string> {
  const binDir = join(cwd, ".git", "fake-bin");
  const ghPath = join(binDir, "gh");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    ghPath,
    `#!/bin/sh
set -eu

if [ "\${1-}" = "--version" ]; then
  echo "gh version 2.0.0"
  exit 0
fi

if [ "\${1-}" = "auth" ] && [ "\${2-}" = "status" ]; then
  echo "Logged in to GitHub"
  exit 0
fi

if [ "\${1-}" = "pr" ] && [ "\${2-}" = "view" ]; then
  pr="\${3-}"
  printf '{"baseRefName":"main","title":"Test PR %s","headRefName":"pr-%s"}\n' "$pr" "$pr"
  exit 0
fi

if [ "\${1-}" = "pr" ] && [ "\${2-}" = "checkout" ]; then
  pr="\${3-}"
  branch="pr-$pr"
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git checkout "$branch"
  else
    git checkout -b "$branch"
  fi
  exit 0
fi

echo "unsupported gh invocation: $*" >&2
exit 1
`,
    "utf8",
  );
  await chmod(ghPath, 0o755);
  return binDir;
}

async function getCurrentBranchName(cwd: string): Promise<string> {
  const result = await execFile("git", ["branch", "--show-current"], { cwd });
  return result.stdout.trim();
}

function getBranchEntries(testSession: TestSession): Array<Record<string, unknown>> {
  return (
    testSession.session as {
      sessionManager: { getBranch: () => Array<Record<string, unknown>> };
    }
  ).sessionManager.getBranch();
}

function appendUserMessage(testSession: TestSession, text: string): void {
  (
    testSession.session as {
      sessionManager: {
        appendMessage: (message: {
          role: "user";
          content: Array<{ type: "text"; text: string }>;
          timestamp: number;
        }) => void;
      };
    }
  ).sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
}

function extractChildSessionPath(command: string): string {
  const match = command.match(/--session '([^']+)'/);
  expect(match?.[1]).toBeTruthy();
  return match[1];
}

async function getCommandArgumentCompletions(
  testSession: TestSession,
  commandName: string,
  prefix: string,
): Promise<Array<{ value: string; label: string; description?: string }> | null> {
  const extensionRunner = (
    testSession.session as {
      extensionRunner: {
        getRegisteredCommands: () => Array<{
          name: string;
          invocationName: string;
          getArgumentCompletions?: (
            argumentPrefix: string,
          ) =>
            | Promise<Array<{ value: string; label: string; description?: string }> | null>
            | Array<{ value: string; label: string; description?: string }>
            | null;
        }>;
      };
    }
  ).extensionRunner;

  const command = extensionRunner
    .getRegisteredCommands()
    .find((registeredCommand) => registeredCommand.invocationName === commandName);
  expect(command?.getArgumentCompletions).toBeTruthy();
  return await command.getArgumentCompletions(prefix);
}

timedTest("review command autocompletes targets, flags, branches, and commits", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-autocomplete-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);
    await commitFile(cwd, "src/index.ts", "export const value = 1;\n", "init review fixture");
    await execFile("git", ["branch", "feature/review-autocomplete"], { cwd });

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    const rootCompletions = await getCommandArgumentCompletions(session, "review", "");
    expect(rootCompletions?.some((item) => item.label === "uncommitted")).toBeTruthy();
    expect(rootCompletions?.some((item) => item.label === "branch")).toBeTruthy();
    expect(rootCompletions?.some((item) => item.label === "commit")).toBeTruthy();
    expect(rootCompletions?.some((item) => item.label === "pr")).toBeTruthy();
    expect(rootCompletions?.some((item) => item.label === "folder")).toBeTruthy();
    expect(rootCompletions?.some((item) => item.label === "--handoff")).toBeTruthy();

    const branchCompletions = await getCommandArgumentCompletions(session, "review", "branch ");
    expect(
      branchCompletions?.some((item) => item.label === "feature/review-autocomplete"),
    ).toBeTruthy();

    const commitCompletions = await getCommandArgumentCompletions(session, "review", "commit ");
    expect(
      commitCompletions?.some((item) => item.description === "init review fixture"),
    ).toBeTruthy();

    const partialTargetCompletions = await getCommandArgumentCompletions(session, "review", "br");
    expect(partialTargetCompletions?.some((item) => item.label === "branch")).toBeTruthy();
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review handoff prompt replaces generic task placeholders", async () => {
  const prompt = buildReviewHandoffPrompt({
    summary: `## Context
We changed the review flow.

## Task
[Clear description of what to do next based on user's goal]`,
    targetLabel: "current changes",
    handoffInstruction: "Focus on state restoration",
    parentSessionPath: "/tmp/parent.jsonl",
  });

  expect(prompt).toMatch(/## Context/);
  expect(prompt).toMatch(
    /## Task\nReview current changes using the review instructions in this prompt\./,
  );
  expect(prompt).toMatch(/Author guidance: Focus on state restoration/);
  expect(prompt).not.toMatch(/\[Clear description of what to do next based on user's goal\]/);
  expect(prompt).toMatch(/## Parent Session/);
});

timedTest("PR reference parsing preserves repo context from GitHub URLs", async () => {
  expect(parsePrReference("123")).toEqual({ prNumber: 123 });
  expect(parsePrReference("https://github.com/org/repo/pull/456")).toEqual({
    prNumber: 456,
    repo: "org/repo",
  });
  expect(parsePrReference("0")).toBe(null);
  expect(parsePrReference("https://github.com/org/repo/pull/456/files")).toEqual({
    prNumber: 456,
    repo: "org/repo",
  });
  expect(parsePrReference("https://github.com/org/repo/pull/456/commits")).toEqual({
    prNumber: 456,
    repo: "org/repo",
  });
  expect(parsePrReference("123abc")).toBe(null);
  expect(parsePrReference("prefix https://github.com/org/repo/pull/456")).toBe(null);
  expect(parsePrReference("https://github.com/org/repo/pull/456/?expand=1#discussion")).toEqual({
    prNumber: 456,
    repo: "org/repo",
  });
  expect(parsePrReference("https://github.com.evil.com/org/repo/pull/456")).toBe(null);
});

timedTest("review path parsing preserves quoted and newline-delimited paths", async () => {
  expect(parseReviewPaths(["src/Architecture Notes", "src/index.ts"])).toEqual([
    "src/Architecture Notes",
    "src/index.ts",
  ]);
  expect(parseReviewPaths('"src/Architecture Notes" src/index.ts')).toEqual([
    "src/Architecture Notes",
    "src/index.ts",
  ]);
  expect(parseReviewPaths("src/Architecture Notes\nsrc/index.ts")).toEqual([
    "src/Architecture Notes",
    "src/index.ts",
  ]);
  expect(parseReviewPaths("src/Architecture Notes\r\n\r\nsrc/index.ts")).toEqual([
    "src/Architecture Notes",
    "src/index.ts",
  ]);
  expect(parseReviewPaths("   \n  \t")).toEqual([]);
});

timedTest("review state is only active on branches containing its anchor", async () => {
  expect(
    isReviewStateActiveOnBranch(
      {
        active: true,
        subagentSessionId: "subagent-1",
        targetLabel: "folders: src",
        branchAnchorId: "anchor-1",
      },
      [{ id: "other-entry" }],
    ),
  ).toBe(false);

  expect(
    isReviewStateActiveOnBranch(
      {
        active: true,
        subagentSessionId: "subagent-1",
        targetLabel: "folders: src",
        branchAnchorId: "anchor-1",
      },
      [{ id: "anchor-1" }],
    ),
  ).toBe(true);

  expect(
    isReviewStateActiveOnBranch(
      {
        active: true,
        subagentSessionId: "subagent-1",
        targetLabel: "folders: src",
      },
      [{ id: "other-entry" }],
    ),
  ).toBe(true);
});
