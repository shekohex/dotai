import { expect, test } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import { createTestSession, type TestSession } from "@support/pi-test-harness";

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

function readLaunchFileBackedValue(command: string, envName: string): string {
  const escapedName = envName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = command.match(new RegExp(`${escapedName}='([^']+)'`));
  return match?.[1] ? readFileSync(match[1], "utf8") : "";
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

timedTest(
  "review command launches a review-mode subagent with target-specific prompt",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-review-command-"));
    let session: TestSession | undefined;
    const mux = new HarnessMuxAdapter();

    try {
      await initGitRepo(cwd);
      await mkdir(join(cwd, "src"), { recursive: true });

      session = await createTestSession({
        cwd,
        extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
      });
      patchHarnessAgent(session);

      await session.session.prompt('/review folder src --extra "focus on performance"');
      await session.session.agent.waitForIdle();

      expect(mux.created.length).toBe(1);
      expect(mux.created[0]?.target).toBe("window");
      expect(mux.created[0]?.command ?? "").toMatch(/--mode-review/);
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toMatch(/Review the code in the following paths: src/);
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toMatch(/Additional user-provided review instruction/);
      expect(
        readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
      ).toMatch(/focus on performance/);

      const reviewState = getBranchEntries(session)
        .filter((entry) => entry.type === "custom" && entry.customType === "review-session")
        .at(-1) as { data?: { active?: boolean; subagentSessionId?: string } } | undefined;
      expect(reviewState?.data?.active).toBe(true);
      expect(typeof reviewState?.data?.subagentSessionId).toBe("string");
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

    expect(mux.created.length).toBe(1);
    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/Review the code in the following paths: src\/Architecture Notes/);
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

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt(
      "/review uncommitted --extra=review something something --handoff",
    );
    await session.session.agent.waitForIdle();

    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/Additional user-provided review instruction/);
    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/review something something/);
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

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt('/review --extra "focus migrations" uncommitted');
    await session.session.agent.waitForIdle();

    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/Review the current code changes \(staged, unstaged, and untracked files\)/);
    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/focus migrations/);
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

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt(
      '/review --extra "focus auth" --handoff "check migrations" uncommitted',
    );
    await session.session.agent.waitForIdle();

    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/Review the current code changes \(staged, unstaged, and untracked files\)/);
    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/focus auth/);
    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/check migrations/);
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

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review --extra focus migration ordering uncommitted");
    await session.session.agent.waitForIdle();

    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/Review the current code changes \(staged, unstaged, and untracked files\)/);
    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/focus migration ordering/);
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

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt("/review --extra");
    await session.session.agent.waitForIdle();

    expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toBe("Missing value for --extra");
    expect(mux.created.length).toBe(0);
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

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt(
      "/review uncommitted --extra Does the new uncommitted flow actually fix parsing",
    );
    await session.session.agent.waitForIdle();

    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/Does the new uncommitted flow actually fix parsing/);
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

    session = await createTestSession({
      cwd,
      extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
    });
    patchHarnessAgent(session);

    await session.session.prompt(
      "/review uncommitted --handoff Verify uncommitted branch behavior before pr checkout",
    );
    await session.session.agent.waitForIdle();

    expect(
      readLaunchFileBackedValue(mux.created[0]?.command ?? "", "PI_SUBAGENT_TASK_FILE"),
    ).toMatch(/Verify uncommitted branch behavior before pr checkout/);
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

    expect(handoffCalls.length).toBe(1);
    expect(handoffCalls[0] ?? "").toMatch(
      /We changed the review extension to branch before launch\./,
    );

    const notifications = session.events
      .uiCallsFor("notify")
      .map((call) => String(call.args[0] ?? ""));
    expect(
      notifications.includes("No session history available for automatic review handoff."),
    ).toBe(false);
  } finally {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
