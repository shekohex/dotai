import { afterEach, expect, test, vi } from "vitest";

import {
  createOsc777Sequence,
  createTmuxPassthroughSequence,
  formatNotification,
  getTmuxClientTty,
  getTmuxPaneTty,
  isSshSession,
  notify,
  terminalNotifyRuntime,
} from "../src/extensions/terminal-notify.js";

const originalTmux = process.env.TMUX;
const originalSshConnection = process.env.SSH_CONNECTION;
const originalSshClient = process.env.SSH_CLIENT;
const originalSshTty = process.env.SSH_TTY;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalTmux === undefined) {
    delete process.env.TMUX;
    return;
  }

  process.env.TMUX = originalTmux;

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

test("formatNotification returns ready title when no assistant text exists", () => {
  expect(formatNotification(null)).toEqual({ title: "Ready for input", body: "" });
});

test("formatNotification strips markdown and truncates body", () => {
  const formatted = formatNotification(
    "# Hi\n\n**bold** and [link](https://example.com)\n\n```ts\nconst x = 1\n```\n" +
      "x".repeat(300),
  );

  expect(formatted.title).toBe("π");
  expect(formatted.body.length).toBeLessThanOrEqual(200);
  expect(formatted.body.includes("https://example.com")).toBeFalsy();
});

test("createOsc777Sequence sanitizes control chars and separators", () => {
  expect(createOsc777Sequence("ti;tle\n", "bo\u0007dy;")).toBe(
    "\u001b]777;notify;ti:tle ;bo dy:\u0007",
  );
});

test("createTmuxPassthroughSequence wraps OSC for tmux passthrough", () => {
  const sequence = createTmuxPassthroughSequence("\u001b]777;notify;π;done\u0007");

  expect(sequence).toBe("\u001bPtmux;\u001b\u001b\u001b]777;notify;π;done\u0007\u001b\\");
});

test("getTmuxPaneTty returns null outside tmux", () => {
  delete process.env.TMUX;

  expect(getTmuxPaneTty()).toBeNull();
});

test("getTmuxPaneTty queries tmux pane tty", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys001\n");

  expect(getTmuxPaneTty()).toBe("/dev/ttys001");
});

test("getTmuxClientTty queries tmux client tty", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys002\n");

  expect(getTmuxClientTty()).toBe("/dev/ttys002");
});

test("isSshSession returns true when SSH markers exist", () => {
  process.env.SSH_CONNECTION = "127.0.0.1 1 127.0.0.1 2";

  expect(isSshSession()).toBeTruthy();
});

test("notify writes passthrough sequence to tmux pane tty", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  delete process.env.SSH_CONNECTION;
  delete process.env.SSH_CLIENT;
  delete process.env.SSH_TTY;
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementation(() => undefined);
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);

  notify("π", "done");

  expect(writeFileSyncSpy).toHaveBeenCalledWith(
    "/dev/ttys009",
    "\u001bPtmux;\u001b\u001b\u001b]777;notify;π;done\u0007\u001b\\",
    { encoding: "utf8" },
  );
  expect(stdoutSpy).not.toHaveBeenCalled();
});

test("notify prefers direct client tty writes inside tmux over SSH", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  process.env.SSH_CLIENT = "127.0.0.1 1 2";
  vi.spyOn(terminalNotifyRuntime, "execFileSync")
    .mockReturnValueOnce("/dev/ttys009\n")
    .mockReturnValueOnce("/dev/ttys010\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementation(() => undefined);
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);

  notify("π", "done");

  expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
  expect(writeFileSyncSpy).toHaveBeenCalledWith("/dev/ttys010", "\u001b]777;notify;π;done\u0007", {
    encoding: "utf8",
  });
  expect(stdoutSpy).not.toHaveBeenCalled();
});

test("notify falls back to client tty passthrough after direct client tty failure", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  process.env.SSH_CONNECTION = "127.0.0.1 1 127.0.0.1 2";
  vi.spyOn(terminalNotifyRuntime, "execFileSync")
    .mockReturnValueOnce("/dev/ttys009\n")
    .mockReturnValueOnce("/dev/ttys010\n");
  const writeFileSyncSpy = vi
    .spyOn(terminalNotifyRuntime, "writeFileSync")
    .mockImplementationOnce(() => {
      throw new Error("client tty direct failed");
    })
    .mockImplementation(() => undefined);
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);

  notify("π", "done");

  expect(writeFileSyncSpy).toHaveBeenNthCalledWith(
    1,
    "/dev/ttys010",
    "\u001b]777;notify;π;done\u0007",
    { encoding: "utf8" },
  );
  expect(writeFileSyncSpy).toHaveBeenNthCalledWith(
    2,
    "/dev/ttys010",
    "\u001bPtmux;\u001b\u001b\u001b]777;notify;π;done\u0007\u001b\\",
    { encoding: "utf8" },
  );
  expect(stdoutSpy).not.toHaveBeenCalled();
});

test("notify falls back to stdout when tmux write fails", () => {
  process.env.TMUX = "/tmp/tmux-1000/default,123,0";
  vi.spyOn(terminalNotifyRuntime, "execFileSync").mockReturnValue("/dev/ttys009\n");
  vi.spyOn(terminalNotifyRuntime, "writeFileSync").mockImplementation(() => {
    throw new Error("no tty");
  });
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);

  notify("π", "done");

  expect(stdoutSpy).toHaveBeenCalledWith("\u001b]777;notify;π;done\u0007");
});

test("notify writes ready for input OSC sequence through runtime stdout", () => {
  delete process.env.TMUX;
  const stdoutSpy = vi.spyOn(terminalNotifyRuntime, "stdoutWrite").mockImplementation(() => true);

  notify("Ready for input", "");

  expect(stdoutSpy).toHaveBeenCalledWith("\u001b]777;notify;Ready for input;\u0007");
});
