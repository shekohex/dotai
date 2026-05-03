import { expect, test } from "vitest";
import { applyToolExecutionSyncPatch } from "../src/remote/client/session/tool-sync-patches.ts";
import { replaySnapshotLiveOverlay } from "../src/remote/client/session/runtime-sync-support.ts";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { SessionSnapshot } from "../src/remote/schemas.ts";

test("tool sync patch normalizes structured partial results for agent events", () => {
  const seenEvents: AgentSessionEvent[] = [];
  const activeSyncToolExecutions = new Map();

  applyToolExecutionSyncPatch({
    payload: {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "session_query",
      args: {
        sessionPath: "/tmp/parent.jsonl",
        question: "What changed?",
      },
    },
    activeSyncToolExecutions,
    applyAgentSessionEvent: (event) => {
      seenEvents.push(event);
    },
  });

  applyToolExecutionSyncPatch({
    payload: {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      partialResult: {
        output: "hi",
      },
    },
    activeSyncToolExecutions,
    applyAgentSessionEvent: (event) => {
      seenEvents.push(event);
    },
  });

  expect(seenEvents).toHaveLength(2);
  expect(seenEvents[1]).toEqual({
    type: "tool_execution_update",
    toolCallId: "tool-1",
    toolName: "session_query",
    args: {
      sessionPath: "/tmp/parent.jsonl",
      question: "What changed?",
    },
    partialResult: {
      content: [],
      details: {
        output: "hi",
      },
    },
  });
});

test("snapshot replay normalizes active tool partial results for agent events", () => {
  const seenEvents: AgentSessionEvent[] = [];

  replaySnapshotLiveOverlay({
    snapshot: {
      sessionId: "session-1",
      sessionName: undefined,
      status: "idle",
      cwd: process.cwd(),
      model: undefined,
      thinkingLevel: "off",
      activeTools: [],
      extensions: [],
      resources: {
        skills: [],
        prompts: [],
        themes: [],
        systemPrompt: "",
        appendSystemPrompt: [],
      },
      settings: {},
      availableModels: [],
      modelSettings: {
        selectedModel: undefined,
        selectedModelId: undefined,
        selectedModelApi: undefined,
        selectedModelProvider: undefined,
      },
      sessionStats: {
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      },
      usageCost: 0,
      autoCompactionEnabled: false,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      entries: [],
      leafId: null,
      transcript: [],
      queue: { depth: 0, nextSequence: 0 },
      live: {
        queuedSteeringMessages: [],
        queuedFollowUpMessages: [],
        retryAttempt: 0,
        activeToolExecutions: [
          {
            toolCallId: "tool-1",
            toolName: "session_query",
            args: {
              sessionPath: "/tmp/parent.jsonl",
              question: "What changed?",
            },
            partialResult: {
              output: "hi",
            },
          },
        ],
      },
      retry: { status: "idle" },
      compaction: { status: "idle" },
      presence: [],
      activeRun: null,
      interruptedRuntimeDomains: {
        queue: false,
        retry: false,
        compaction: false,
        bash: false,
        streaming: false,
      },
      pendingUiRequests: [],
      uiState: { statuses: [], widgets: [] },
      durableExtensionState: [],
      streamingState: "idle",
      isBashRunning: false,
      hasPendingBashMessages: false,
      pendingToolCalls: [],
      errorMessage: null,
      version: "1",
    } satisfies SessionSnapshot,
    forwardAgentSessionEventToLocalExtensions: (event) => {
      seenEvents.push(event);
    },
  });

  expect(seenEvents).toEqual([
    {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "session_query",
      args: {
        sessionPath: "/tmp/parent.jsonl",
        question: "What changed?",
      },
    },
    {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "session_query",
      args: {
        sessionPath: "/tmp/parent.jsonl",
        question: "What changed?",
      },
      partialResult: {
        content: [],
        details: {
          output: "hi",
        },
      },
    },
  ]);
});
