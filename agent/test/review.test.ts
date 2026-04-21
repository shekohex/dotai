import test from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(match?.[1]);
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
  assert.ok(command?.getArgumentCompletions);
  return await command.getArgumentCompletions(prefix);
}

timedTest(
  "review command launches a review-mode subagent with target-specific prompt",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-review-command-"));
    let session: TestSession | undefined;
    const mux = new HarnessMuxAdapter();

    try {
      await initGitRepo(cwd);
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeReviewModesFile(cwd);

      session = await createTestSession({
        cwd,
        extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
      });
      patchHarnessAgent(session);

      await session.session.prompt('/review folder src --extra "focus on performance"');
      await session.session.agent.waitForIdle();

      assert.equal(mux.created.length, 1);
      assert.equal(mux.created[0]?.target, "window");
      assert.match(mux.created[0]?.command ?? "", /--mode-review/);
      assert.match(mux.created[0]?.command ?? "", /Review the code in the following paths: src/);
      assert.match(mux.created[0]?.command ?? "", /Additional user-provided review instruction/);
      assert.match(mux.created[0]?.command ?? "", /focus on performance/);

      const reviewState = getBranchEntries(session)
        .filter((entry) => entry.type === "custom" && entry.customType === "review-session")
        .at(-1) as { data?: { active?: boolean; subagentSessionId?: string } } | undefined;
      assert.equal(reviewState?.data?.active, true);
      assert.equal(typeof reviewState?.data?.subagentSessionId, "string");
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

timedTest("review command keeps quoted folder paths intact", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-folder-quotes-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src", "Architecture Notes"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          completionActionPicker: async () => {},
        }),
      ],
    });
    patchHarnessAgent(session);

    await session.session.prompt('/review folder "src/Architecture Notes"');
    await session.session.agent.waitForIdle();

    assert.equal(mux.created.length, 1);
    assert.match(
      mux.created[0]?.command ?? "",
      /Review the code in the following paths: src\/Architecture Notes/,
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review preserves multi-word --extra values with equals syntax", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-extra-equals-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt(
      "/review uncommitted --extra=review something something --handoff",
    );
    await session.session.agent.waitForIdle();

    assert.match(mux.created[0]?.command ?? "", /Additional user-provided review instruction/);
    assert.match(mux.created[0]?.command ?? "", /review something something/);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review supports flag-first target parsing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-flag-first-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt('/review --extra "focus migrations" uncommitted');
    await session.session.agent.waitForIdle();

    assert.match(
      mux.created[0]?.command ?? "",
      /Review the current code changes \(staged, unstaged, and untracked files\)/,
    );
    assert.match(mux.created[0]?.command ?? "", /focus migrations/);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review supports multi-flag target-first parsing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-multi-flag-first-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt(
      '/review --extra "focus auth" --handoff "check migrations" uncommitted',
    );
    await session.session.agent.waitForIdle();

    assert.match(
      mux.created[0]?.command ?? "",
      /Review the current code changes \(staged, unstaged, and untracked files\)/,
    );
    assert.match(mux.created[0]?.command ?? "", /focus auth/);
    assert.match(mux.created[0]?.command ?? "", /check migrations/);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review supports unquoted flag-first --extra values", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-flag-first-unquoted-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review --extra focus migration ordering uncommitted");
    await session.session.agent.waitForIdle();

    assert.match(
      mux.created[0]?.command ?? "",
      /Review the current code changes \(staged, unstaged, and untracked files\)/,
    );
    assert.match(mux.created[0]?.command ?? "", /focus migration ordering/);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review rejects --extra with no value", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-extra-missing-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review --extra");
    await session.session.agent.waitForIdle();

    assert.equal(session.events.uiCallsFor("notify").at(-1)?.args[0], "Missing value for --extra");
    assert.equal(mux.created.length, 0);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review preserves target keywords inside --extra text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-extra-keywords-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt(
      "/review uncommitted --extra Does the new uncommitted flow actually fix parsing",
    );
    await session.session.agent.waitForIdle();

    assert.match(
      mux.created[0]?.command ?? "",
      /Does the new uncommitted flow actually fix parsing/,
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review preserves target keywords inside --handoff text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-handoff-keywords-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt(
      "/review uncommitted --handoff Verify uncommitted branch behavior before pr checkout",
    );
    await session.session.agent.waitForIdle();

    assert.match(
      mux.created[0]?.command ?? "",
      /Verify uncommitted branch behavior before pr checkout/,
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review generates handoff from the parent session before branching", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-handoff-parent-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();
  const handoffCalls: string[] = [];

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          handoffGenerator: async ({ messages }) => {
            handoffCalls.push(
              messages.map((message) => JSON.stringify(message.content)).join("\n"),
            );
            return { summary: "## Context\nUse parent context." };
          },
        }),
      ],
    });
    patchHarnessAgent(session);

    appendUserMessage(session, "We changed the review extension to branch before launch.");
    await session.session.prompt('/review folder src --extra "focus on performance" --handoff');
    await session.session.agent.waitForIdle();

    assert.equal(handoffCalls.length, 1);
    assert.match(
      handoffCalls[0] ?? "",
      /We changed the review extension to branch before launch\./,
    );

    const notifications = session.events
      .uiCallsFor("notify")
      .map((call) => String(call.args[0] ?? ""));
    assert.equal(
      notifications.includes("No session history available for automatic review handoff."),
      false,
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review refuses to start a second review while one is already running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-running-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();
    await session.session.prompt("/review uncommitted");
    await session.session.agent.waitForIdle();

    assert.equal(
      session.events.uiCallsFor("notify").at(-1)?.args[0],
      "A review is already running. Wait for it to finish first.",
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review auto-clears state after the subagent completes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-complete-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          completionActionPicker: async () => {},
        }),
      ],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    assert.ok(command);
    const childSessionPath = extractChildSessionPath(command);
    mux.existingPanes.delete(mux.created[0]!.paneId);
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "## Findings\n\nNo findings." }],
        },
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await new Promise((resolve) => setTimeout(resolve, 2_600));

    const reviewState = getBranchEntries(session)
      .filter((entry) => entry.type === "custom" && entry.customType === "review-session")
      .at(-1) as { data?: { active?: boolean } } | undefined;
    assert.equal(reviewState?.data?.active, false);

    assert.equal(session.events.uiCallsFor("notify").at(-1)?.args[0], "Review complete.");

    const childSessionContents = await readFile(childSessionPath, "utf8");
    assert.match(childSessionContents, /assistant-1/);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("completed review offers an action picker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-complete-actions-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();
  const pickedSummaries: string[] = [];

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          completionActionPicker: async ({ summary }) => {
            pickedSummaries.push(summary);
            return;
          },
        }),
      ],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    assert.ok(command);
    const childSessionPath = extractChildSessionPath(command);
    mux.existingPanes.delete(mux.created[0]!.paneId);
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "## Findings\n\n- [P1] Fix parsing." }],
        },
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await new Promise((resolve) => setTimeout(resolve, 2_600));

    assert.equal(session.events.uiCallsFor("notify").at(-1)?.args[0], "Review complete.");
    assert.equal(pickedSummaries.length, 1);
    assert.match(pickedSummaries[0] ?? "", /\[P1\] Fix parsing\./);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review loads REVIEW_GUIDELINES.md from repo root without .pi", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-guidelines-"));

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "packages", "feature"), { recursive: true });
    await writeFile(join(cwd, "REVIEW_GUIDELINES.md"), "Always check migrations.\n", "utf8");

    assert.equal(
      await loadProjectReviewGuidelines(join(cwd, "packages", "feature")),
      "Always check migrations.",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review guidelines lookup does not read above git root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "agent-review-guidelines-boundary-"));
  const cwd = join(parent, "repo");

  try {
    await mkdir(cwd, { recursive: true });
    await initGitRepo(cwd);
    await mkdir(join(cwd, "packages", "feature"), { recursive: true });
    await writeFile(join(parent, "REVIEW_GUIDELINES.md"), "outside repo\n", "utf8");

    assert.equal(await loadProjectReviewGuidelines(join(cwd, "packages", "feature")), null);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

timedTest("completed review can copy the summary to the clipboard", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-copy-summary-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();
  const copiedSummaries: string[] = [];
  let copyPicked = 0;

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          completionActionPicker: async () => {
            copyPicked += 1;
            return "copy";
          },
          clipboardWriter: async (text) => {
            copiedSummaries.push(text);
          },
        }),
      ],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    assert.ok(command);
    const childSessionPath = extractChildSessionPath(command);
    mux.existingPanes.delete(mux.created[0]!.paneId);
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "## Findings\n\n- [P1] Fix parsing." }],
        },
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await new Promise((resolve) => setTimeout(resolve, 2_600));

    assert.equal(copyPicked, 1);
    assert.deepEqual(copiedSummaries, ["## Findings\n\n- [P1] Fix parsing."]);
    assert.equal(
      session.events
        .uiCallsFor("notify")
        .map((call) => String(call.args[0] ?? ""))
        .includes("Copied review summary to clipboard."),
      true,
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("completed review can fork into a new fix branch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-fork-summary-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();
  let forkPicked = 0;
  const navigatedTargets: string[] = [];
  const summarizeValues: boolean[] = [];
  const labels: string[] = [];

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          completionActionPicker: async () => {
            forkPicked += 1;
            return "fork";
          },
          reviewFixBranchNavigator: async ({ targetId, summarize, label }) => {
            navigatedTargets.push(targetId);
            summarizeValues.push(summarize);
            labels.push(label);
            return { cancelled: false };
          },
        }),
      ],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    assert.ok(command);
    const childSessionPath = extractChildSessionPath(command);
    mux.existingPanes.delete(mux.created[0]!.paneId);
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "## Findings\n\n- [P1] Fix parsing." }],
        },
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await new Promise((resolve) => setTimeout(resolve, 2_600));
    const entries = getBranchEntries(session);
    const activeReviewState = entries
      .filter((entry) => entry.type === "custom" && entry.customType === "review-session")
      .map((entry) => (entry as { data?: { active?: boolean; branchAnchorId?: string } }).data)
      .find((data) => data?.active);
    const latestAnchor = entries
      .filter((entry) => entry.type === "custom" && entry.customType === "review-anchor")
      .at(-1);

    assert.equal(forkPicked, 1);
    assert.equal(navigatedTargets.length, 1);
    assert.deepEqual(summarizeValues, [true]);
    assert.deepEqual(labels, ["review-fixes"]);
    assert.equal(navigatedTargets[0] !== "", true);
    assert.equal(navigatedTargets[0], activeReviewState?.branchAnchorId);
    assert.equal(navigatedTargets[0], latestAnchor?.id as string | undefined);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("completed review reports handoff runner exceptions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-handoff-address-error-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          completionActionPicker: async () => "handoff",
          handoffAddressRunner: async () => {
            throw new Error("handoff crashed");
          },
        }),
      ],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    assert.ok(command);
    const childSessionPath = extractChildSessionPath(command);
    mux.existingPanes.delete(mux.created[0]!.paneId);
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "## Findings\n\n- [P1] Fix parsing." }],
        },
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await new Promise((resolve) => setTimeout(resolve, 2_600));

    assert.equal(
      session.events
        .uiCallsFor("notify")
        .map((call) => String(call.args[0] ?? ""))
        .some((message) => message.includes("Failed to start review handoff: handoff crashed")),
      true,
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("completed review can handoff and address findings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-handoff-address-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();
  let handoffPicked = 0;
  const handoffGoals: string[] = [];

  try {
    await initGitRepo(cwd);
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeReviewModesFile(cwd);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          completionActionPicker: async () => {
            handoffPicked += 1;
            return "handoff";
          },
          handoffAddressRunner: async ({ goal }) => {
            handoffGoals.push(goal);
            return { status: "started" };
          },
        }),
      ],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    assert.ok(command);
    const childSessionPath = extractChildSessionPath(command);
    mux.existingPanes.delete(mux.created[0]!.paneId);
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "## Findings\n\n- [P1] Fix parsing." }],
        },
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await new Promise((resolve) => setTimeout(resolve, 2_600));

    assert.equal(handoffPicked, 1);
    assert.equal(handoffGoals.length, 1);
    assert.match(
      handoffGoals[0] ?? "",
      /Please Address and fix the following findings:\n## Findings\n\n- \[P1\] Fix parsing\./,
    );
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review restores the original branch after PR review completes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-pr-restore-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();
  const previousPath = process.env.PATH;

  try {
    await initGitRepo(cwd);
    await writeReviewModesFile(cwd);
    await execFile("git", ["add", ".pi/modes.json"], { cwd });
    await execFile("git", ["commit", "-m", "add review mode"], { cwd });
    await commitFile(cwd, ".gitignore", "auth.json\n", "ignore harness auth");
    await commitFile(cwd, "README.md", "base\n", "init");

    const fakeGhBin = await writeFakeGh(cwd);
    process.env.PATH = [fakeGhBin, previousPath].filter(Boolean).join(delimiter);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          completionActionPicker: async () => {},
        }),
      ],
    });
    patchHarnessAgent(session);

    assert.equal(await getCurrentBranchName(cwd), "main");

    await session.session.prompt("/review pr 7");
    await session.session.agent.waitForIdle();

    assert.equal(await getCurrentBranchName(cwd), "pr-7");

    const command = mux.created[0]?.command;
    assert.ok(command);
    const childSessionPath = extractChildSessionPath(command);
    mux.existingPanes.delete(mux.created[0]!.paneId);
    await writeFile(
      childSessionPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "## Findings\n\nNo findings." }],
        },
      })}\n`,
      { encoding: "utf8", flag: "a" },
    );

    await new Promise((resolve) => setTimeout(resolve, 2_600));

    assert.equal(await getCurrentBranchName(cwd), "main");
    assert.equal(session.events.uiCallsFor("notify").at(-1)?.args[0], "Review complete.");
  } finally {
    process.env.PATH = previousPath;
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review restores the original branch when PR handoff generation aborts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-pr-handoff-abort-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();
  const previousPath = process.env.PATH;

  try {
    await initGitRepo(cwd);
    await writeReviewModesFile(cwd);
    await execFile("git", ["add", ".pi/modes.json"], { cwd });
    await execFile("git", ["commit", "-m", "add review mode"], { cwd });
    await commitFile(cwd, ".gitignore", "auth.json\n", "ignore harness auth");
    await commitFile(cwd, "README.md", "base\n", "init");

    const fakeGhBin = await writeFakeGh(cwd);
    process.env.PATH = [fakeGhBin, previousPath].filter(Boolean).join(delimiter);

    session = await createTestSession({
      cwd,
      extensionFactories: [
        createReviewExtension({
          adapterFactory: () => mux,
          handoffGenerator: async () => ({ aborted: true }),
        }),
      ],
    });
    patchHarnessAgent(session);

    assert.equal(await getCurrentBranchName(cwd), "main");
    appendUserMessage(session, "Please review the PR carefully.");

    await session.session.prompt("/review pr 7 --handoff");
    await session.session.agent.waitForIdle();

    assert.equal(await getCurrentBranchName(cwd), "main");
    assert.equal(session.events.uiCallsFor("notify").at(-1)?.args[0], "Review cancelled");
  } finally {
    process.env.PATH = previousPath;
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("review blocks PR checkout when untracked files are present", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-pr-untracked-"));
  let session: TestSession | undefined;
  const mux = new HarnessMuxAdapter();
  const previousPath = process.env.PATH;

  try {
    await initGitRepo(cwd);
    await writeReviewModesFile(cwd);
    await execFile("git", ["add", ".pi/modes.json"], { cwd });
    await execFile("git", ["commit", "-m", "add review mode"], { cwd });
    await commitFile(cwd, ".gitignore", "auth.json\n", "ignore harness auth");
    await commitFile(cwd, "README.md", "base\n", "init");
    await writeFile(join(cwd, "untracked.txt"), "local draft\n", "utf8");

    const fakeGhBin = await writeFakeGh(cwd);
    process.env.PATH = [fakeGhBin, previousPath].filter(Boolean).join(delimiter);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review pr 7");
    await session.session.agent.waitForIdle();

    assert.equal(await getCurrentBranchName(cwd), "main");
    assert.equal(
      session.events.uiCallsFor("notify").at(-1)?.args[0],
      "PR review failed. Returning to review menu.",
    );
    assert.equal(mux.created.length, 0);
  } finally {
    process.env.PATH = previousPath;
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

timedTest("failed PR review startup restores the original branch after checkout", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-pr-failure-"));
  let session: TestSession | undefined;
  const mux = new FailingMuxAdapter();
  const previousPath = process.env.PATH;

  try {
    await initGitRepo(cwd);
    await writeReviewModesFile(cwd);
    await execFile("git", ["add", ".pi/modes.json"], { cwd });
    await execFile("git", ["commit", "-m", "add review mode"], { cwd });
    await commitFile(cwd, ".gitignore", "auth.json\n", "ignore harness auth");
    await commitFile(cwd, "README.md", "base\n", "init");

    const fakeGhBin = await writeFakeGh(cwd);
    process.env.PATH = [fakeGhBin, previousPath].filter(Boolean).join(delimiter);

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review pr 7");
    await session.session.agent.waitForIdle();

    assert.equal(await getCurrentBranchName(cwd), "main");
    assert.match(
      String(session.events.uiCallsFor("notify").at(-1)?.args[0] ?? ""),
      /Failed to start review: mux create failed/,
    );
  } finally {
    process.env.PATH = previousPath;
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

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
    assert.ok(rootCompletions?.some((item) => item.label === "uncommitted"));
    assert.ok(rootCompletions?.some((item) => item.label === "branch"));
    assert.ok(rootCompletions?.some((item) => item.label === "commit"));
    assert.ok(rootCompletions?.some((item) => item.label === "pr"));
    assert.ok(rootCompletions?.some((item) => item.label === "folder"));
    assert.ok(rootCompletions?.some((item) => item.label === "--handoff"));

    const branchCompletions = await getCommandArgumentCompletions(session, "review", "branch ");
    assert.ok(branchCompletions?.some((item) => item.label === "feature/review-autocomplete"));

    const commitCompletions = await getCommandArgumentCompletions(session, "review", "commit ");
    assert.ok(commitCompletions?.some((item) => item.description === "init review fixture"));

    const partialTargetCompletions = await getCommandArgumentCompletions(session, "review", "br");
    assert.ok(partialTargetCompletions?.some((item) => item.label === "branch"));
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

  assert.match(prompt, /## Context/);
  assert.match(
    prompt,
    /## Task\nReview current changes using the review instructions in this prompt\./,
  );
  assert.match(prompt, /Author guidance: Focus on state restoration/);
  assert.doesNotMatch(prompt, /\[Clear description of what to do next based on user's goal\]/);
  assert.match(prompt, /## Parent Session/);
});

timedTest("PR reference parsing preserves repo context from GitHub URLs", async () => {
  assert.deepEqual(parsePrReference("123"), { prNumber: 123 });
  assert.deepEqual(parsePrReference("https://github.com/org/repo/pull/456"), {
    prNumber: 456,
    repo: "org/repo",
  });
  assert.equal(parsePrReference("0"), null);
  assert.deepEqual(parsePrReference("https://github.com/org/repo/pull/456/files"), {
    prNumber: 456,
    repo: "org/repo",
  });
  assert.deepEqual(parsePrReference("https://github.com/org/repo/pull/456/commits"), {
    prNumber: 456,
    repo: "org/repo",
  });
  assert.equal(parsePrReference("123abc"), null);
  assert.equal(parsePrReference("prefix https://github.com/org/repo/pull/456"), null);
  assert.deepEqual(parsePrReference("https://github.com/org/repo/pull/456/?expand=1#discussion"), {
    prNumber: 456,
    repo: "org/repo",
  });
  assert.equal(parsePrReference("https://github.com.evil.com/org/repo/pull/456"), null);
});

timedTest("review path parsing preserves quoted and newline-delimited paths", async () => {
  assert.deepEqual(parseReviewPaths(["src/Architecture Notes", "src/index.ts"]), [
    "src/Architecture Notes",
    "src/index.ts",
  ]);
  assert.deepEqual(parseReviewPaths('"src/Architecture Notes" src/index.ts'), [
    "src/Architecture Notes",
    "src/index.ts",
  ]);
  assert.deepEqual(parseReviewPaths("src/Architecture Notes\nsrc/index.ts"), [
    "src/Architecture Notes",
    "src/index.ts",
  ]);
  assert.deepEqual(parseReviewPaths("src/Architecture Notes\r\n\r\nsrc/index.ts"), [
    "src/Architecture Notes",
    "src/index.ts",
  ]);
  assert.deepEqual(parseReviewPaths("   \n  \t"), []);
});

timedTest("review state is only active on branches containing its anchor", async () => {
  assert.equal(
    isReviewStateActiveOnBranch(
      {
        active: true,
        subagentSessionId: "subagent-1",
        targetLabel: "folders: src",
        branchAnchorId: "anchor-1",
      },
      [{ id: "other-entry" }],
    ),
    false,
  );

  assert.equal(
    isReviewStateActiveOnBranch(
      {
        active: true,
        subagentSessionId: "subagent-1",
        targetLabel: "folders: src",
        branchAnchorId: "anchor-1",
      },
      [{ id: "anchor-1" }],
    ),
    true,
  );

  assert.equal(
    isReviewStateActiveOnBranch(
      {
        active: true,
        subagentSessionId: "subagent-1",
        targetLabel: "folders: src",
      },
      [{ id: "other-entry" }],
    ),
    true,
  );
});
