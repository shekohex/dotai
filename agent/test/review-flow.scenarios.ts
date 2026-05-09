import { expect, test } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
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

async function waitForCondition(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

function setSessionPersistence(testSession: TestSession, persisted: boolean): void {
  const sessionManager = (
    testSession.session as { sessionManager: { isPersisted?: () => boolean } }
  ).sessionManager as {
    isPersisted?: () => boolean;
  };
  sessionManager.isPersisted = () => persisted;
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

async function waitForReviewCompletion(testSession: TestSession): Promise<void> {
  await waitForCondition(() => {
    const entries = getBranchEntries(testSession);
    const latestReviewState = entries
      .filter((entry) => entry.type === "custom" && entry.customType === "review-session")
      .at(-1) as { data?: { active?: boolean } } | undefined;
    const latestNotification = testSession.events.uiCallsFor("notify").at(-1)?.args[0];
    return latestReviewState?.data?.active === false && latestNotification === "Review complete.";
  });
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

timedTest("review refuses to start a second review while one is already running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-review-running-"));
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

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();
    await session.session.prompt("/review uncommitted");
    await session.session.agent.waitForIdle();

    expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toBe(
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
    setSessionPersistence(session, true);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    expect(command).toBeTruthy();
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

    await waitForReviewCompletion(session);

    const reviewState = getBranchEntries(session)
      .filter((entry) => entry.type === "custom" && entry.customType === "review-session")
      .at(-1) as { data?: { active?: boolean } } | undefined;
    expect(reviewState?.data?.active).toBe(false);

    expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toBe("Review complete.");

    const childSessionContents = await readFile(childSessionPath, "utf8");
    expect(childSessionContents).toMatch(/assistant-1/);
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
    setSessionPersistence(session, true);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    expect(command).toBeTruthy();
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

    await waitForCondition(() => pickedSummaries.length === 1);

    expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toBe("Review complete.");
    expect(pickedSummaries.length).toBe(1);
    expect(pickedSummaries[0] ?? "").toMatch(/\[P1\] Fix parsing\./);
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

    expect(await loadProjectReviewGuidelines(join(cwd, "packages", "feature"))).toBe(
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

    expect(await loadProjectReviewGuidelines(join(cwd, "packages", "feature"))).toBe(null);
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
    setSessionPersistence(session, true);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    expect(command).toBeTruthy();
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

    await waitForCondition(() => copyPicked === 1 && copiedSummaries.length === 1);

    expect(copyPicked).toBe(1);
    expect(copiedSummaries).toEqual(["## Findings\n\n- [P1] Fix parsing."]);
    expect(
      session.events
        .uiCallsFor("notify")
        .map((call) => String(call.args[0] ?? ""))
        .includes("Copied review summary to clipboard."),
    ).toBe(true);
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
    setSessionPersistence(session, true);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    expect(command).toBeTruthy();
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

    await waitForCondition(() => forkPicked === 1 && navigatedTargets.length === 1);
    const entries = getBranchEntries(session);
    const activeReviewState = entries
      .filter((entry) => entry.type === "custom" && entry.customType === "review-session")
      .map((entry) => (entry as { data?: { active?: boolean; branchAnchorId?: string } }).data)
      .find((data) => data?.active);
    const latestAnchor = entries
      .filter((entry) => entry.type === "custom" && entry.customType === "review-anchor")
      .at(-1);

    expect(forkPicked).toBe(1);
    expect(navigatedTargets.length).toBe(1);
    expect(summarizeValues).toEqual([true]);
    expect(labels).toEqual(["review-fixes"]);
    expect(navigatedTargets[0] !== "").toBe(true);
    expect(navigatedTargets[0]).toBe(activeReviewState?.branchAnchorId);
    expect(navigatedTargets[0]).toBe(latestAnchor?.id as string | undefined);
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
    setSessionPersistence(session, true);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    expect(command).toBeTruthy();
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

    await waitForCondition(() => {
      return session.events
        .uiCallsFor("notify")
        .map((call) => String(call.args[0] ?? ""))
        .some((message) => message.includes("Failed to start review handoff: handoff crashed"));
    });

    expect(
      session.events
        .uiCallsFor("notify")
        .map((call) => String(call.args[0] ?? ""))
        .some((message) => message.includes("Failed to start review handoff: handoff crashed")),
    ).toBe(true);
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
    setSessionPersistence(session, true);

    await session.session.prompt("/review folder src");
    await session.session.agent.waitForIdle();

    const command = mux.created[0]?.command;
    expect(command).toBeTruthy();
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

    await waitForReviewCompletion(session);

    expect(handoffPicked).toBe(1);
    expect(handoffGoals.length).toBe(1);
    expect(handoffGoals[0] ?? "").toMatch(
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
    await execFile("git", ["commit", "--allow-empty", "-m", "add review mode"], { cwd });
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
    setSessionPersistence(session, true);

    expect(await getCurrentBranchName(cwd)).toBe("main");

    await session.session.prompt("/review pr 7");
    await session.session.agent.waitForIdle();

    expect(await getCurrentBranchName(cwd)).toBe("pr-7");

    const command = mux.created[0]?.command;
    expect(command).toBeTruthy();
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

    await waitForReviewCompletion(session);

    expect(await getCurrentBranchName(cwd)).toBe("main");
    expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toBe("Review complete.");
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
    await execFile("git", ["commit", "--allow-empty", "-m", "add review mode"], { cwd });
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
    setSessionPersistence(session, true);

    expect(await getCurrentBranchName(cwd)).toBe("main");
    appendUserMessage(session, "Please review the PR carefully.");

    await session.session.prompt("/review pr 7 --handoff");
    await session.session.agent.waitForIdle();

    expect(await getCurrentBranchName(cwd)).toBe("main");
    expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toBe("Review cancelled");
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
    await execFile("git", ["commit", "--allow-empty", "-m", "add review mode"], { cwd });
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

    expect(await getCurrentBranchName(cwd)).toBe("main");
    expect(session.events.uiCallsFor("notify").at(-1)?.args[0]).toBe(
      "PR review failed. Returning to review menu.",
    );
    expect(mux.created.length).toBe(0);
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
    await execFile("git", ["commit", "--allow-empty", "-m", "add review mode"], { cwd });
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

    expect(await getCurrentBranchName(cwd)).toBe("main");
    expect(String(session.events.uiCallsFor("notify").at(-1)?.args[0] ?? "")).toMatch(
      /Failed to start review: mux create failed/,
    );
  } finally {
    process.env.PATH = previousPath;
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
