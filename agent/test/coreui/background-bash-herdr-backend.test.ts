import { afterEach, describe, expect, test, vi } from "vitest";

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe("HerdrBackgroundShellBackend", () => {
  const originalHerdrWorkspaceId = process.env.HERDR_WORKSPACE_ID;

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    if (originalHerdrWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = originalHerdrWorkspaceId;
  });

  test("launches background command in a new Herdr tab root pane", async () => {
    process.env.HERDR_WORKSPACE_ID = "w1";
    const calls: Array<{ command: string; args: string[] }> = [];
    vi.doMock("node:util", () => ({
      promisify:
        (
          fn: (
            command: string,
            args: string[],
            options: unknown,
            callback: ExecFileCallback,
          ) => void,
        ) =>
        (command: string, args: string[], options: unknown) =>
          new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
            fn(command, args, options, (error, stdout, stderr) => {
              if (error) reject(error);
              else resolve({ stdout, stderr });
            });
          }),
    }));
    vi.doMock("node:child_process", () => ({
      execFile(
        command: string,
        args: string[],
        callbackOrOptions: unknown,
        maybeCallback?: ExecFileCallback,
      ) {
        calls.push({ command, args });
        const callback =
          typeof callbackOrOptions === "function" ? callbackOrOptions : maybeCallback;
        callback?.(null, '{"result":{"root_pane":{"pane_id":"w1:p9"}}}', "");
      },
    }));
    const { HerdrBackgroundShellBackend } =
      await import("../../src/extensions/coreui/background-bash-herdr-backend.js");

    const backend = new HerdrBackgroundShellBackend();
    const launched = await backend.launch({
      command: "npm test",
      cwd: "/repo",
      description: "runs tests",
      exitFile: "/tmp/run.exit",
      id: "run-1",
      label: "npm",
      outputFile: "/tmp/run.out",
      scriptPath: "/tmp/run.sh",
      startedAt: 1,
    });

    expect(launched).toEqual({
      backend: "herdr",
      targetId: "w1:p9",
      targetLabel: "herdr pane w1:p9",
    });
    expect(calls[0]?.args).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repo",
      "--label",
      "npm",
      "--no-focus",
    ]);
    expect(calls[1]?.args).toEqual([
      "pane",
      "run",
      "w1:p9",
      " { '/tmp/run.sh'; }; __pi_background_status=$?; herdr pane close 'w1:p9'; exit $__pi_background_status",
    ]);
  });

  test("kill propagates Herdr close failures", async () => {
    vi.doMock("node:util", () => ({
      promisify:
        (
          fn: (
            command: string,
            args: string[],
            options: unknown,
            callback: ExecFileCallback,
          ) => void,
        ) =>
        (command: string, args: string[], options: unknown) =>
          new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
            fn(command, args, options, (error, stdout, stderr) => {
              if (error) reject(error);
              else resolve({ stdout, stderr });
            });
          }),
    }));
    vi.doMock("node:child_process", () => ({
      execFile(
        _command: string,
        _args: string[],
        callbackOrOptions: unknown,
        maybeCallback?: ExecFileCallback,
      ) {
        const callback =
          typeof callbackOrOptions === "function" ? callbackOrOptions : maybeCallback;
        callback?.(new Error("timeout"), "", "timeout");
      },
    }));
    const { HerdrBackgroundShellBackend } =
      await import("../../src/extensions/coreui/background-bash-herdr-backend.js");

    const backend = new HerdrBackgroundShellBackend();
    await expect(
      backend.kill({
        backend: "herdr",
        command: "npm test",
        cwd: "/repo",
        exitFile: "/tmp/run.exit",
        id: "run-1",
        outputFile: "/tmp/run.out",
        startedAt: 1,
        status: "running",
        targetId: "w1:p9",
        targetLabel: "herdr pane w1:p9",
      }),
    ).rejects.toThrow("timeout");
  });

  test("kill tolerates already-missing Herdr panes", async () => {
    vi.doMock("node:util", () => ({
      promisify:
        (
          fn: (
            command: string,
            args: string[],
            options: unknown,
            callback: ExecFileCallback,
          ) => void,
        ) =>
        (command: string, args: string[], options: unknown) =>
          new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
            fn(command, args, options, (error, stdout, stderr) => {
              if (error) reject(error);
              else resolve({ stdout, stderr });
            });
          }),
    }));
    vi.doMock("node:child_process", () => ({
      execFile(
        _command: string,
        _args: string[],
        callbackOrOptions: unknown,
        maybeCallback?: ExecFileCallback,
      ) {
        const callback =
          typeof callbackOrOptions === "function" ? callbackOrOptions : maybeCallback;
        const error = new Error("pane not found") as Error & { stderr: string };
        error.stderr = "pane not found";
        callback?.(error, "", "pane not found");
      },
    }));
    const { HerdrBackgroundShellBackend } =
      await import("../../src/extensions/coreui/background-bash-herdr-backend.js");

    const backend = new HerdrBackgroundShellBackend();
    await expect(
      backend.kill({
        backend: "herdr",
        command: "npm test",
        cwd: "/repo",
        exitFile: "/tmp/run.exit",
        id: "run-1",
        outputFile: "/tmp/run.out",
        startedAt: 1,
        status: "running",
        targetId: "w1:p9",
        targetLabel: "herdr pane w1:p9",
      }),
    ).resolves.toBeUndefined();
  });
});
