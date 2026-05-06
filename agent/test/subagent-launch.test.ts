import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLaunchCommand,
  CHILD_STATE_FILE_ENV,
  CHILD_STATE_ENV,
  PI_COMMAND_ENV,
  readChildState,
  SUBAGENT_DEBUG_ENV_ALLOWLIST,
} from "../src/subagent-sdk/launch.ts";
import type { RuntimeSubagent } from "../src/subagent-sdk/types.ts";

const previousPiCommand = process.env[PI_COMMAND_ENV];
const previousDebugProviderRequests = process.env.PI_DEBUG_PROVIDER_REQUESTS;
const previousDebugSystemPrompt = process.env.PI_DEBUG_SYSTEM_PROMPT;
const previousDebugProviderRequestsLog = process.env.PI_DEBUG_PROVIDER_REQUESTS_LOG;
const previousChildStateFile = process.env[CHILD_STATE_FILE_ENV];
const previousChildState = process.env[CHILD_STATE_ENV];

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

  if (previousDebugProviderRequests === undefined) {
    delete process.env.PI_DEBUG_PROVIDER_REQUESTS;
  } else {
    process.env.PI_DEBUG_PROVIDER_REQUESTS = previousDebugProviderRequests;
  }

  if (previousDebugSystemPrompt === undefined) {
    delete process.env.PI_DEBUG_SYSTEM_PROMPT;
  } else {
    process.env.PI_DEBUG_SYSTEM_PROMPT = previousDebugSystemPrompt;
  }

  if (previousDebugProviderRequestsLog === undefined) {
    delete process.env.PI_DEBUG_PROVIDER_REQUESTS_LOG;
  } else {
    process.env.PI_DEBUG_PROVIDER_REQUESTS_LOG = previousDebugProviderRequestsLog;
  }

  if (previousChildStateFile === undefined) {
    delete process.env[CHILD_STATE_FILE_ENV];
  } else {
    process.env[CHILD_STATE_FILE_ENV] = previousChildStateFile;
  }

  if (previousChildState === undefined) {
    delete process.env[CHILD_STATE_ENV];
  } else {
    process.env[CHILD_STATE_ENV] = previousChildState;
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

  it("forwards allowlisted provider debug env vars to child sessions", () => {
    process.env[PI_COMMAND_ENV] = "pi";
    process.env.PI_DEBUG_PROVIDER_REQUESTS = "1";
    process.env.PI_DEBUG_SYSTEM_PROMPT = "true";
    process.env.PI_DEBUG_PROVIDER_REQUESTS_LOG = "/tmp/provider-debug-child.jsonl";

    const command = buildLaunchCommand(
      createState(),
      {
        sessionId: "session-1",
        prompt: "inspect",
        parentSessionId: "parent-1",
        parentSessionPath: "/tmp/parent-1.jsonl",
        stateEntryId: `${CHILD_STATE_ENV}-1`,
        modeName: "gsd-executor",
        modeLabel: "GSD executor",
        handoff: false,
        persisted: true,
      },
      "inspect",
      {
        tmuxTarget: "window",
        mode: "gsd-executor",
        systemPromptMode: "replace",
      },
    );

    expect(SUBAGENT_DEBUG_ENV_ALLOWLIST).toEqual([
      "PI_DEBUG_PROVIDER_REQUESTS",
      "PI_DEBUG_SYSTEM_PROMPT",
      "PI_DEBUG_PROVIDER_REQUESTS_LOG",
    ]);
    expect(command).toContain("PI_DEBUG_PROVIDER_REQUESTS='1'");
    expect(command).toContain("PI_DEBUG_SYSTEM_PROMPT='true'");
    expect(command).toContain("PI_DEBUG_PROVIDER_REQUESTS_LOG='/tmp/provider-debug-child.jsonl'");
  });

  it("does not pass mode startup flags for child launches", () => {
    process.env[PI_COMMAND_ENV] = "pi";

    const command = buildLaunchCommand(
      createState(),
      {
        sessionId: "session-1",
        prompt: "map codebase",
        parentSessionId: "parent-1",
        parentSessionPath: "/tmp/parent-1.jsonl",
        stateEntryId: `${CHILD_STATE_ENV}-1`,
        modeName: "gsd-codebase-mapper",
        modeLabel: "GSD codebase mapper",
        handoff: false,
        persisted: true,
      },
      "map codebase",
      {
        tmuxTarget: "window",
        mode: "gsd-codebase-mapper",
        model: "codex-openai/gpt-5.4-mini",
        thinkingLevel: "high",
        systemPromptMode: "replace",
      },
    );

    expect(command).not.toContain("--mode-gsd-codebase-mapper");
    expect(command).toContain("--model 'codex-openai/gpt-5.4-mini'");
    expect(command).toContain("--thinking 'high'");
  });

  it("fails closed only for strict file-backed child state", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-launch-invalid-"));
    const filePath = path.join(dir, "child-state.json");
    await fs.writeFile(filePath, "{not-json", "utf8");
    delete process.env[CHILD_STATE_ENV];
    process.env[CHILD_STATE_FILE_ENV] = filePath;

    expect(readChildState()).toBeUndefined();
    expect(() => readChildState({ strictFile: true })).toThrow(
      `Failed to load child bootstrap state from ${filePath}:`,
    );

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("falls through to valid file-backed child state when env JSON is malformed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-launch-fallback-"));
    const filePath = path.join(dir, "child-state.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        sessionId: "child-session-id",
        parentSessionId: "parent-session-id",
        name: "worker-one",
        prompt: "Return structured output",
        autoExit: true,
        handoff: false,
        tools: ["read"],
        startedAt: Date.now(),
      }),
      "utf8",
    );
    process.env[CHILD_STATE_ENV] = "{bad-json";
    process.env[CHILD_STATE_FILE_ENV] = filePath;

    expect(readChildState()?.sessionId).toBe("child-session-id");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
