import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SessionManager,
  getDefaultSessionDir as getUpstreamDefaultSessionDir,
  type SessionEntry,
  type SessionMessageEntry,
} from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js";

import { extractMessageText } from "../extensions/session-launch-utils.js";
import {
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  SUBAGENT_STATE_ENTRY,
  parseSubagentStructuredOutputEntry,
  parseSubagentStateEntry,
  type SubagentStructuredOutputEntry,
  type StructuredOutputError,
  type RuntimeSubagent,
  type SubagentStateEntry,
} from "./types.js";

type SessionBootstrapWriter = {
  _rewriteFile(): void;
};

type ChildSessionOutcome = {
  summary?: string;
  structured?: unknown;
  structuredError?: StructuredOutputError;
  failed: boolean;
};

export type ChildSessionStatus = "running" | "idle";

export type ChildSessionStatusDetails = {
  status: ChildSessionStatus;
  idleSinceAt?: number;
};

export const SUBAGENT_PARENT_INPUT_GRACE_MS = 1500;

type ExpiringMarker = {
  expiresAt?: number;
};

type TimeoutModeMarker = {
  activatedAt?: number;
};

type AssistantOutcomeMessage = SessionMessageEntry["message"] & {
  role: "assistant";
  stopReason?: string;
  content: string | Array<{ type: string; text?: string }>;
};

type StructuredOutputEntry = {
  structured?: unknown;
  error?: StructuredOutputError;
};

export function getDefaultSessionDir(cwd: string): string {
  return getUpstreamDefaultSessionDir(cwd);
}

export function getParentInjectedInputMarkerPath(sessionId: string): string {
  return path.join(os.tmpdir(), "pi-subagent-input", `${sessionId}.json`);
}

export function getAutoExitTimeoutModeMarkerPath(sessionId: string): string {
  return path.join(os.tmpdir(), "pi-subagent-timeout-mode", `${sessionId}.json`);
}

export function consumeParentInjectedInputMarker(sessionId: string): boolean {
  const markerPath = getParentInjectedInputMarkerPath(sessionId);
  let marker: ExpiringMarker | undefined;

  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as ExpiringMarker;
  } catch {
    return false;
  }

  try {
    fs.unlinkSync(markerPath);
  } catch {
    return typeof marker.expiresAt === "number" && marker.expiresAt > Date.now();
  }

  return typeof marker.expiresAt === "number" && marker.expiresAt > Date.now();
}

export function activateAutoExitTimeoutMode(sessionId: string): void {
  const markerPath = getAutoExitTimeoutModeMarkerPath(sessionId);

  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ activatedAt: Date.now() } satisfies TimeoutModeMarker),
      "utf8",
    );
  } catch {
    return;
  }
}

export function isAutoExitTimeoutModeActive(sessionId: string): boolean {
  try {
    const marker = JSON.parse(
      fs.readFileSync(getAutoExitTimeoutModeMarkerPath(sessionId), "utf8"),
    ) as TimeoutModeMarker;
    return typeof marker.activatedAt === "number";
  } catch {
    return false;
  }
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
    let summary: string | undefined;
    let failed = false;
    let structured: unknown;
    let structuredError: StructuredOutputError | undefined;

    while (entry) {
      const structuredEntry = getStructuredOutputEntry(entry);
      if (structuredEntry && structured === undefined && structuredError === undefined) {
        structured = structuredEntry.structured;
        structuredError = structuredEntry.error;
      }

      const message = getAssistantOutcomeMessage(entry);
      if (message && summary === undefined) {
        const extractedSummary = extractMessageText(message.content).trim();
        summary = extractedSummary || undefined;
        failed = message.stopReason === "error" || message.stopReason === "aborted";
      }

      entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
    }

    return {
      summary,
      structured,
      structuredError,
      failed: failed || structuredError !== undefined,
    };
  } catch {
    return { failed: true };
  }
}

export function readLatestChildStructuredOutputState(
  sessionPath: string,
): SubagentStructuredOutputEntry | undefined {
  try {
    const sessionManager = SessionManager.open(sessionPath);
    let entry = sessionManager.getLeafEntry();

    while (entry) {
      if (entry.type === "custom" && entry.customType === SUBAGENT_STRUCTURED_OUTPUT_ENTRY) {
        return parseSubagentStructuredOutputEntry(entry.data);
      }

      entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export async function readChildSessionStatus(sessionPath: string): Promise<ChildSessionStatus> {
  return (await readChildSessionStatusDetails(sessionPath)).status;
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function readChildSessionStatusDetails(
  sessionPath: string,
): Promise<ChildSessionStatusDetails> {
  try {
    const sessionManager = SessionManager.open(sessionPath);
    let entry = sessionManager.getLeafEntry();

    while (entry) {
      if (entry.type === "message") {
        if (entry.message.role === "assistant") {
          return {
            status: "idle",
            idleSinceAt: parseTimestampMs(
              (entry as SessionEntry & { timestamp?: unknown }).timestamp,
            ),
          };
        }

        return { status: "running" };
      }

      entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
    }
  } catch {
    return { status: "running" };
  }

  return { status: "running" };
}

export function reduceRuntimeSubagents(
  entries: SessionEntry[],
  parentSessionId: string,
): Map<string, RuntimeSubagent> {
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
  if (
    entry.type !== "message" ||
    entry.message.role !== "assistant" ||
    !("content" in entry.message)
  ) {
    return undefined;
  }

  return entry.message as AssistantOutcomeMessage;
}

function getStructuredOutputEntry(entry: SessionEntry): StructuredOutputEntry | undefined {
  if (entry.type !== "custom" || entry.customType !== SUBAGENT_STRUCTURED_OUTPUT_ENTRY) {
    return undefined;
  }

  const parsed = parseSubagentStructuredOutputEntry(entry.data);
  if (!parsed) {
    return undefined;
  }

  if (parsed.status === "captured") {
    return { structured: parsed.structured };
  }

  if (parsed.status === "error" && parsed.error) {
    return { error: parsed.error };
  }

  return undefined;
}
