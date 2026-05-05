import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLaunchCommand,
  CHILD_STATE_FILE_ENV,
  CHILD_STATE_ENV,
  PI_COMMAND_ENV,
} from "../src/subagent-sdk/launch.ts";
import type { RuntimeSubagent } from "../src/subagent-sdk/types.ts";

const previousPiCommand = process.env[PI_COMMAND_ENV];

function createState(): RuntimeSubagent {
  return {
    sessionId: "session-1",
    sessionPath: "/tmp/session-1.jsonl",
    parentSessionId: "parent-1",
    parentSessionPath: "/tmp/parent-1.jsonl",
    paneId: "%1",
    name: "worker",
    task: "task",
    handoff: false,
    autoExit: true,
    autoExitTimeoutActive: false,
    status: "running",
    startedAt: 1,
    updatedAt: 1,
    modeName: "gsd-executor",
    modeLabel: "GSD executor",
    persisted: true,
  };
}

afterEach(() => {
  if (previousPiCommand === undefined) {
    delete process.env[PI_COMMAND_ENV];
  } else {
    process.env[PI_COMMAND_ENV] = previousPiCommand;
  }
});

describe("buildLaunchCommand", () => {
  it("stores task and system prompt in temp files instead of inlining payloads", () => {
    process.env[PI_COMMAND_ENV] = "pi";
    const task = "x".repeat(5000);
    const systemPrompt = "y".repeat(6000);
    const command = buildLaunchCommand(
      createState(),
      {
        sessionId: "session-1",
        prompt: task,
        parentSessionId: "parent-1",
        parentSessionPath: "/tmp/parent-1.jsonl",
        stateEntryId: `${CHILD_STATE_ENV}-1`,
        modeName: "gsd-executor",
        modeLabel: "GSD executor",
        handoff: false,
        persisted: true,
      },
      task,
      {
        tmuxTarget: "window",
        mode: "gsd-executor",
        systemPrompt,
        systemPromptMode: "replace",
      },
    );

    expect(command).toContain(`${CHILD_STATE_FILE_ENV}=`);
    expect(command).toContain("PI_SUBAGENT_SYSTEM_PROMPT_FILE=");
    expect(command).toContain('$(cat "$PI_SUBAGENT_SYSTEM_PROMPT_FILE")');
    expect(command).toContain("PI_SUBAGENT_TASK_FILE=");
    expect(command).toContain('$(cat "$PI_SUBAGENT_TASK_FILE")');
    expect(command).not.toContain(systemPrompt);
    expect(command).not.toContain(task);

    const childStatePath = command.match(/PI_SUBAGENT_CHILD_STATE_FILE='([^']+)'/)?.[1];
    const systemPromptPath = command.match(/PI_SUBAGENT_SYSTEM_PROMPT_FILE='([^']+)'/)?.[1];
    const taskPath = command.match(/PI_SUBAGENT_TASK_FILE='([^']+)'/)?.[1];
    expect(childStatePath).toBeDefined();
    expect(systemPromptPath).toBeDefined();
    expect(taskPath).toBeDefined();
    expect(existsSync(childStatePath ?? "")).toBe(true);
    expect(existsSync(systemPromptPath ?? "")).toBe(true);
    expect(existsSync(taskPath ?? "")).toBe(true);
    expect(readFileSync(childStatePath ?? "", "utf8")).toContain(`"prompt":"${task}"`);
    expect(readFileSync(systemPromptPath ?? "", "utf8")).toBe(systemPrompt);
    expect(readFileSync(taskPath ?? "", "utf8")).toBe(task);
  });
});
