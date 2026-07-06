import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { HerdrAdapter } from "../src/subagent-sdk/herdr.js";

type ExecCall = {
  command: string;
  args: string[];
  options?: ExecOptions;
};

function execResult(stdout = "", stderr = "", code = 0): ExecResult {
  return { stdout, stderr, code, killed: false };
}

function createExecRecorder() {
  const calls: ExecCall[] = [];
  const exec = (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
    calls.push({ command, args, options });
    if (args[0] === "tab" && args[1] === "create") {
      return Promise.resolve(execResult('{"result":{"root_pane":{"pane_id":"w1:p2"}}}'));
    }
    if (args[0] === "pane" && args[1] === "split") {
      return Promise.resolve(execResult('{"result":{"pane":{"pane_id":"w1:p3"}}}'));
    }
    return Promise.resolve(execResult());
  };
  return { calls, exec };
}

describe("HerdrAdapter", () => {
  const originalHerdrEnv = process.env.HERDR_ENV;
  const originalHerdrPaneId = process.env.HERDR_PANE_ID;
  const originalHerdrWorkspaceId = process.env.HERDR_WORKSPACE_ID;

  afterEach(() => {
    if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = originalHerdrEnv;
    if (originalHerdrPaneId === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = originalHerdrPaneId;
    if (originalHerdrWorkspaceId === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = originalHerdrWorkspaceId;
  });

  test("uses herdr tab create for window targets", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "w1";
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    const pane = await adapter.createPane({
      command: "pi child",
      cwd: "/repo",
      target: "window",
      title: "child",
    });

    expect(pane.paneId).toBe("w1:p2");
    expect(recorder.calls[0]?.args).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/repo",
      "--label",
      "child",
      "--no-focus",
    ]);
    expect(recorder.calls.at(-1)?.args).toEqual([
      "pane",
      "run",
      "w1:p2",
      " { pi child; }; __pi_subagent_status=$?; herdr pane close 'w1:p2'; exit $__pi_subagent_status",
    ]);
  });

  test("checks availability with bounded Herdr status command", async () => {
    process.env.HERDR_ENV = "1";
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    await expect(adapter.isAvailable()).resolves.toBe(true);

    expect(recorder.calls[0]).toEqual({
      command: "herdr",
      args: ["status", "server"],
      options: { cwd: "/repo", timeout: 2000 },
    });
  });

  test("passes current Herdr pane when splitting pane targets", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    await adapter.createPane({
      command: "pi child",
      cwd: "/repo",
      target: "pane",
      title: "child",
    });

    expect(recorder.calls[0]?.args).toEqual([
      "pane",
      "split",
      "w1:p1",
      "--direction",
      "right",
      "--cwd",
      "/repo",
      "--no-focus",
    ]);
  });

  test("falls back to --current when HERDR_PANE_ID is unavailable", async () => {
    process.env.HERDR_ENV = "1";
    delete process.env.HERDR_PANE_ID;
    const recorder = createExecRecorder();
    const adapter = new HerdrAdapter(recorder.exec, "/repo");

    await adapter.createPane({
      command: "pi child",
      cwd: "/repo",
      target: "pane",
      title: "child",
    });

    expect(recorder.calls[0]?.args[2]).toBe("--current");
  });
});
