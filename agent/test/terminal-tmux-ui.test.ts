import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

import {
  clearTmuxTitle,
  createClearOscTitleSequence,
  createOscTitleSequence,
  emitTmuxProgress,
  emitTmuxTitle,
  getDefaultTmuxTitle,
  isTmuxSession,
  default as terminalTmuxUiExtension,
  writeTmuxUiSequence,
} from "../src/extensions/terminal-tmux-ui.js";
import { terminalNotifyRuntime } from "../src/extensions/terminal-notify.js";

const originalTmux = process.env.TMUX;
const originalSshConnection = process.env.SSH_CONNECTION;
const originalSshClient = process.env.SSH_CLIENT;
const originalSshTty = process.env.SSH_TTY;

afterEach(() => {
  vi.restoreAllMocks();

  if (originalTmux === undefined) {
    delete process.env.TMUX;
  } else {
    process.env.TMUX = originalTmux;
  }

  if (originalSshConnection === undefined) {
    delete process.env.SSH_CONNECTION;
  } else {
    process.env.SSH_CONNECTION = originalSshConnection;
  }

  if (originalSshClient === undefined) {
    delete process.env.SSH_CLIENT;
  } else {
    process.env.SSH_CLIENT = originalSshClient;
  }

  if (originalSshTty === undefined) {
    delete process.env.SSH_TTY;
  } else {
    process.env.SSH_TTY = originalSshTty;
  }
});

test("isTmuxSession returns false outside tmux", () => {
  delete process.env.TMUX;

  expect(isTmuxSession()).toBeFalsy();
});

test("createOscTitleSequence sanitizes control chars", () => {
  expect(createOscTitleSequence("π\n;title")).toBe("\u001b]0;π ;title\u0007");
});

test("createClearOscTitleSequence clears terminal title", () => {
  expect(createClearOscTitleSequence()).toBe("\u001b]0;\u0007");
});

test("getDefaultTmuxTitle includes session name and cwd basename", () => {
  const title = getDefaultTmuxTitle({ getSessionName: () => "feature" }, "/tmp/project-name");

  expect(title).toBe("π - feature - project-name");
});

test("session_start handler uses current ctx session manager instead of captured pi", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_TTY;

  let sessionStartHandler:
    | ((
        event: unknown,
        ctx: { cwd: string; sessionManager: { getSessionName(): string | undefined } },
      ) => void)
    | undefined;
  const extensionApi = {
    getSessionName: () => {
      throw new Error("stale pi");
    },
    on: (eventName: string, handler: typeof sessionStartHandler) => {
      if (eventName === "session_start") {
        sessionStartHandler = handler;
      }
    },
  } as unknown as ExtensionAPI;
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementation(() => undefined);

  terminalTmuxUiExtension(extensionApi);

  expect(sessionStartHandler).toBeDefined();
  sessionStartHandler?.(
    {},
    {
      cwd: "/tmp/project-name",
      sessionManager: { getSessionName: () => "fresh-session" },
    },
  );

  expect(writeFileSyncSpy).toHaveBeenCalledWith(
    "/dev/ttys009",
    "\u001bPtmux;\u001b\u001b\u001b]0;π - fresh-session - project-name\u0007\u001b\\",
    { encoding: "utf8" },
  );
});

test("agent_end ignores stale replacement ctx", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_TTY;

  let agentEndHandler:
    | ((
        event: unknown,
        ctx: { cwd: string; sessionManager: { getSessionName(): string | undefined } },
      ) => void)
    | undefined;
  const extensionApi = {
    on: (eventName: string, handler: typeof agentEndHandler) => {
      if (eventName === "agent_end") {
        agentEndHandler = handler;
      }
    },
  } as unknown as ExtensionAPI;
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementation(() => undefined);

  terminalTmuxUiExtension(extensionApi);

  expect(agentEndHandler).toBeDefined();
  expect(() =>
    agentEndHandler?.(
      {},
      {
        get cwd() {
          throw new Error(
            "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
          );
        },
        sessionManager: { getSessionName: () => "fresh-session" },
      },
    ),
  ).not.toThrow();
  expect(writeFileSyncSpy).toHaveBeenCalledWith(
    "/dev/ttys009",
    "\u001bPtmux;\u001b\u001b\u001b]9;4;0;\u0007\u001b\\",
    { encoding: "utf8" },
  );
});

test("emitTmuxTitle writes direct OSC title to client tty over SSH", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  process.env.SSH_CONNECTION = "127.0.0.1 1 127.0.0.1 2";
  vi.spyOn(terminalNotifyRuntime, "execFileSync")
    .mockReturnValueOnce("/dev/ttys009\n")
    .mockReturnValueOnce("/dev/ttys010\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementation(() => undefined);

  expect(emitTmuxTitle("π - project")).toBeTruthy();
  expect(writeFileSyncSpy).toHaveBeenCalledWith("/dev/ttys010", "\u001b]0;π - project\u0007", {
    encoding: "utf8",
  });
});

test("emitTmuxProgress falls back to pane tty passthrough", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_TTY;
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementation(() => undefined);

  expect(emitTmuxProgress(true)).toBeTruthy();
  expect(writeFileSyncSpy).toHaveBeenCalledWith(
    "/dev/ttys009",
    "\u001bPtmux;\u001b\u001b\u001b]9;4;3\u0007\u001b\\",
    { encoding: "utf8" },
  );
});

test("clearTmuxTitle writes clear title sequence", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  process.env.SSH_CONNECTION = "127.0.0.1 1 127.0.0.1 2";
  vi.spyOn(terminalNotifyRuntime, "execFileSync")
    .mockReturnValueOnce("/dev/ttys009\n")
    .mockReturnValueOnce("/dev/ttys010\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementation(() => undefined);

  expect(clearTmuxTitle()).toBeTruthy();
  expect(writeFileSyncSpy).toHaveBeenCalledWith("/dev/ttys010", "\u001b]0;\u0007", {
    encoding: "utf8",
  });
});

test("writeTmuxUiSequence falls back to client tty passthrough after direct write failure", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  process.env.SSH_CLIENT = "127.0.0.1 1 2";
  vi.spyOn(terminalNotifyRuntime, "execFileSync")
    .mockReturnValueOnce("/dev/ttys009\n")
    .mockReturnValueOnce("/dev/ttys010\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementationOnce(() => {
      throw new Error("direct failed");
    })
    .mockImplementation(() => undefined);

  expect(writeTmuxUiSequence("\u001b]0;π - agent\u0007")).toBeTruthy();
  expect(writeFileSyncSpy).toHaveBeenNthCalledWith(1, "/dev/ttys010", "\u001b]0;π - agent\u0007", {
    encoding: "utf8",
  });
  expect(writeFileSyncSpy).toHaveBeenNthCalledWith(
    2,
    "/dev/ttys010",
    "\u001bPtmux;\u001b\u001b\u001b]0;π - agent\u0007\u001b\\",
    { encoding: "utf8" },
  );
});
