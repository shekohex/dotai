import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundShellBackend } from "../../src/extensions/coreui/background-bash-backend.js";
import { BACKGROUND_SHELL_COMPLETION_MESSAGE } from "../../src/extensions/coreui/background-bash-types.js";
import { runBackgroundCommand } from "../../src/extensions/coreui/background-bash.js";

type SendMessageCall = {
  message: { customType: string; content: string; display: boolean; details?: unknown };
  options?: { deliverAs?: string; triggerTurn?: boolean };
};

const launchedExitFiles: string[] = [];

const fakeBackend: BackgroundShellBackend = {
  name: "pty",
  isAvailable: () => Promise.resolve(true),
  launch: (input) => {
    launchedExitFiles.push(input.exitFile);
    return Promise.resolve({
      backend: "pty",
      targetId: `pty:${input.id}`,
      targetLabel: `pty ${input.id}`,
    });
  },
  targetExists: () => Promise.resolve(true),
  kill: () => Promise.resolve(),
  formatInspectHint: () => "",
  formatPeekHint: () => "",
  formatKillHint: () => "",
};

vi.mock("../../src/extensions/coreui/background-bash-backends.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/extensions/coreui/background-bash-backends.js")
    >();
  return {
    ...actual,
    selectBackgroundShellBackend: () => Promise.resolve(fakeBackend),
  };
});

let cwd: string;

// Module-level watcher in background-bash.ts captures the first pi it sees,
// so all tests share one pi spy and clear calls between tests.
const sharedPi: ExtensionAPI = {
  sendMessage: vi.fn(() => Promise.resolve()),
} as unknown as ExtensionAPI;

function sendMessageCalls(pi: ExtensionAPI): SendMessageCall[] {
  return (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(
    ([message, options]: SendMessageCall["message"] extends never ? never : [never, never]) =>
      ({ message, options }) as SendMessageCall,
  );
}

async function waitFor(
  probe: () => SendMessageCall[] | undefined,
  timeoutMs = 3000,
): Promise<SendMessageCall[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value.length > 0) return value;
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createContext(): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

async function completeRun(exitFile: string, exitCode: string): Promise<void> {
  await writeFile(exitFile, `${exitCode}\n`);
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-background-bash-notifications-"));
  launchedExitFiles.length = 0;
  (sharedPi.sendMessage as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("background bash exit notifications", () => {
  test("completion is delivered promptly as steer while agent turn is active", async () => {
    const pi = sharedPi;
    const result = await runBackgroundCommand({
      command: { command: "sleep 30" },
      ctx: createContext(),
      description: "dev server",
      pi,
    });
    const exitFile = result.details?.exitFile;
    expect(exitFile).toBeDefined();

    await completeRun(exitFile as string, "0");
    const calls = await waitFor(() =>
      sendMessageCalls(pi).filter(
        (call) => call.message.customType === BACKGROUND_SHELL_COMPLETION_MESSAGE,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(calls[0].message.content).toContain("exit 0");
  });

  test("repeated exit-file events do not replay the completion notification", async () => {
    const pi = sharedPi;
    const result = await runBackgroundCommand({
      command: { command: "sleep 30" },
      ctx: createContext(),
      description: "dev server",
      pi,
    });
    const exitFile = result.details?.exitFile as string;

    await completeRun(exitFile, "0");
    await waitFor(() =>
      sendMessageCalls(pi).filter(
        (call) => call.message.customType === BACKGROUND_SHELL_COMPLETION_MESSAGE,
      ),
    );
    await completeRun(exitFile, "0");
    await completeRun(exitFile, "1");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const completions = sendMessageCalls(pi).filter(
      (call) => call.message.customType === BACKGROUND_SHELL_COMPLETION_MESSAGE,
    );
    expect(completions).toHaveLength(1);
  });

  test("multiple background commands each notify once via steer", async () => {
    const pi = sharedPi;
    const first = await runBackgroundCommand({
      command: { command: "sleep 30" },
      ctx: createContext(),
      description: "first",
      pi,
    });
    const second = await runBackgroundCommand({
      command: { command: "sleep 30" },
      ctx: createContext(),
      description: "second",
      pi,
    });

    await completeRun(first.details?.exitFile as string, "0");
    await completeRun(second.details?.exitFile as string, "0");
    await waitFor(() => {
      const completions = sendMessageCalls(pi).filter(
        (call) => call.message.customType === BACKGROUND_SHELL_COMPLETION_MESSAGE,
      );
      return completions.length === 2 ? completions : undefined;
    });

    const completions = sendMessageCalls(pi).filter(
      (call) => call.message.customType === BACKGROUND_SHELL_COMPLETION_MESSAGE,
    );
    expect(completions).toHaveLength(2);
    for (const call of completions) {
      expect(call.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    }
  });
});
