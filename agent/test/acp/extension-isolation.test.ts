import { execFile as execFileCallback } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { createTestSession, says, when, type TestSession } from "@support/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import modesExtension from "../../src/extensions/modes.js";
import { createReviewExtension } from "../../src/extensions/review.js";
import type { MuxAdapter, PaneSubmitMode } from "../../src/subagent-sdk/mux.js";
import {
  defineModesFile,
  registerBuiltInModes,
  unregisterBuiltInModes,
} from "../../src/mode-utils.js";

process.env.OPENAI_API_KEY ??= "test-key";

const MODE_SOURCE = "acp-extension-isolation";
const sessions: TestSession[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  unregisterBuiltInModes(MODE_SOURCE);
  for (const session of sessions.splice(0)) {
    const cwd = session.cwd;
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

describe("ACP extension isolation", () => {
  test("simultaneous mode runtimes keep independent active modes", async () => {
    registerBuiltInModes(
      MODE_SOURCE,
      defineModesFile({
        version: 1,
        modes: {
          alpha: {
            provider: "openai",
            modelId: "gpt-4o",
            systemPrompt: "ALPHA SESSION PROMPT",
            systemPromptMode: "replace",
          },
          beta: {
            provider: "openai",
            modelId: "gpt-4o",
            systemPrompt: "BETA SESSION PROMPT",
            systemPromptMode: "replace",
          },
        },
      }),
    );

    const firstPrompts: string[] = [];
    const secondPrompts: string[] = [];
    const first = await createModeSession(firstPrompts);
    const second = await createModeSession(secondPrompts);
    sessions.push(first, second);
    patchHarnessAgent(first);
    patchHarnessAgent(second);

    await first.session.prompt("/mode alpha");
    await second.session.prompt("/mode beta");
    await first.run(when("first turn", [says("first")]));
    await second.run(when("second turn", [says("second")]));

    expect(firstPrompts.at(-1)).toContain("ALPHA SESSION PROMPT");
    expect(secondPrompts.at(-1)).toContain("BETA SESSION PROMPT");
  });

  test("simultaneous review runtimes launch through their owning session", async () => {
    const firstMux = new IsolationMuxAdapter();
    const secondMux = new IsolationMuxAdapter();
    const first = await createReviewSession(firstMux);
    const second = await createReviewSession(secondMux);
    sessions.push(first, second);
    patchHarnessAgent(first);
    patchHarnessAgent(second);

    await first.session.prompt("/review folder src");
    await first.session.agent.waitForIdle();
    await second.session.prompt("/review folder src");
    await second.session.agent.waitForIdle();

    expect(firstMux.created).toHaveLength(1);
    expect(secondMux.created).toHaveLength(1);
  });
});

function createModeSession(prompts: string[]): Promise<TestSession> {
  const capturePromptExtension = (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", (event) => {
      prompts.push(event.systemPrompt);
    });
  };
  return createTestSession({ extensionFactories: [modesExtension, capturePromptExtension] });
}

function patchHarnessAgent(testSession: TestSession): void {
  const agent = testSession.session.agent as {
    state: { tools: unknown[] };
    setTools?: (tools: unknown[]) => void;
  };
  agent.setTools ??= (tools) => {
    agent.state.tools = tools;
  };
}

async function createReviewSession(mux: IsolationMuxAdapter): Promise<TestSession> {
  const session = await createTestSession({
    extensionFactories: [createReviewExtension({ adapterFactory: () => mux })],
  });
  await execFile("git", ["init", "-b", "main"], { cwd: session.cwd });
  await execFile("git", ["config", "user.name", "ACP Test"], { cwd: session.cwd });
  await execFile("git", ["config", "user.email", "acp@example.test"], { cwd: session.cwd });
  await mkdir(`${session.cwd}/src`, { recursive: true });
  return session;
}

class IsolationMuxAdapter implements MuxAdapter {
  readonly backend = "tmux";
  readonly created: string[] = [];

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  createPane(): Promise<{ paneId: string }> {
    const paneId = `%${this.created.length + 1}`;
    this.created.push(paneId);
    return Promise.resolve({ paneId });
  }

  sendText(_paneId: string, _text: string, _submitMode?: PaneSubmitMode): Promise<void> {
    return Promise.resolve();
  }

  paneExists(): Promise<boolean> {
    return Promise.resolve(true);
  }

  killPane(): Promise<void> {
    return Promise.resolve();
  }

  capturePane(): Promise<{ text: string }> {
    return Promise.resolve({ text: "" });
  }
}
