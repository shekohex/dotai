import os from "node:os";
import path from "node:path";

import {
  SessionManager,
  getDefaultSessionDir as getUpstreamDefaultSessionDir,
  type SessionEntry,
  type SessionMessageEntry,
} from "../../../node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js";

import { extractMessageText } from "../session-launch-utils.js";
import {
  SUBAGENT_STATE_ENTRY,
  parseSubagentStateEntry,
  type RuntimeSubagent,
  type SubagentStateEntry,
} from "./types.js";

type SessionBootstrapWriter = {
  _rewriteFile(): void;
};

type ChildSessionOutcome = {
  summary?: string;
  failed: boolean;
};

export type ChildSessionStatus = "running" | "idle";

export const SUBAGENT_PARENT_INPUT_GRACE_MS = 1500;

type AssistantOutcomeMessage = SessionMessageEntry["message"] & {
  role: "assistant";
  stopReason?: string;
  content: string | Array<{ type: string; text?: string }>;
};

export function getDefaultSessionDir(cwd: string): string {
  return getUpstreamDefaultSessionDir(cwd);
}

export function getParentInjectedInputMarkerPath(sessionId: string): string {
  return path.join(os.tmpdir(), "pi-subagent-input", `${sessionId}.json`);
}

export async function createChildSessionFile(options: {
  cwd: string;
  sessionId: string;
  parentSessionPath?: string;
}): Promise<string> {
  const sessionManager = SessionManager.create(options.cwd, getDefaultSessionDir(options.cwd));
  const sessionPath = sessionManager.newSession({
    id: options.sessionId,
    parentSession: options.parentSessionPath,
  });

  if (!sessionPath) {
    throw new Error("Failed to allocate child session path");
  }

  persistSessionBootstrap(sessionManager);
  return sessionPath;
}

export async function readChildSessionOutcome(sessionPath: string): Promise<ChildSessionOutcome> {
  try {
    const sessionManager = SessionManager.open(sessionPath);
    let entry = sessionManager.getLeafEntry();

    while (entry) {
      const message = getAssistantOutcomeMessage(entry);
      if (!message) {
        entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
        continue;
      }

      const summary = extractMessageText(message.content).trim();
      return {
        summary: summary || undefined,
        failed: message.stopReason === "error" || message.stopReason === "aborted",
      };
    }
  } catch {
    return { failed: true };
  }

  return { failed: true };
}

export async function readChildSessionStatus(sessionPath: string): Promise<ChildSessionStatus> {
  try {
    const sessionManager = SessionManager.open(sessionPath);
    let entry = sessionManager.getLeafEntry();

    while (entry) {
      if (entry.type === "message") {
        return entry.message.role === "assistant" ? "idle" : "running";
      }

      entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
    }
  } catch {
    return "running";
  }

  return "running";
}

export function reduceRuntimeSubagents(entries: SessionEntry[], parentSessionId: string): Map<string, RuntimeSubagent> {
  const states = new Map<string, RuntimeSubagent>();

  for (const entry of entries) {
    const state = getSubagentStateEntry(entry);
    if (!state) {
      continue;
    }

    if (state.parentSessionId !== parentSessionId) {
      continue;
    }

    states.set(state.sessionId, {
      ...state,
      modeLabel: state.mode ?? "worker",
    });
  }

  return states;
}

function persistSessionBootstrap(sessionManager: SessionManager): void {
  const writablePrototype = SessionManager.prototype as unknown as Partial<SessionBootstrapWriter>;
  if (typeof writablePrototype._rewriteFile !== "function") {
    throw new Error("SessionManager bootstrap persistence is unavailable");
  }

  writablePrototype._rewriteFile.call(sessionManager);
}

function getSubagentStateEntry(entry: SessionEntry): SubagentStateEntry | undefined {
  if (entry.type !== "custom" || entry.customType !== SUBAGENT_STATE_ENTRY) {
    return undefined;
  }

  return parseSubagentStateEntry(entry.data);
}

function getAssistantOutcomeMessage(entry: SessionEntry): AssistantOutcomeMessage | undefined {
  if (entry.type !== "message" || entry.message.role !== "assistant" || !("content" in entry.message)) {
    return undefined;
  }

  return entry.message as AssistantOutcomeMessage;
}
