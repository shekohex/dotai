import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SessionManager,
  getDefaultSessionDir as getUpstreamDefaultSessionDir,
  type SessionEntry,
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
import {
  getAssistantOutcomeMessage,
  getStructuredOutputEntry,
  parseExpiringMarker,
  parseTimeoutModeMarker,
  parseTimestampMs,
  type ExpiringMarker,
  type TimeoutModeMarker,
} from "./persistence-helpers.js";

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
    marker = parseExpiringMarker(JSON.parse(fs.readFileSync(markerPath, "utf8")));
  } catch {
    return false;
  }

  if (!marker) {
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
  } catch {}
}

export function isAutoExitTimeoutModeActive(sessionId: string): boolean {
  try {
    const marker = parseTimeoutModeMarker(
      JSON.parse(fs.readFileSync(getAutoExitTimeoutModeMarkerPath(sessionId), "utf8")),
    );
    if (!marker) {
      return false;
    }
    return typeof marker.activatedAt === "number";
  } catch {
    return false;
  }
}

export function createChildSessionFile(options: {
  cwd: string;
  sessionId: string;
  parentSessionPath?: string;
}): string {
  const sessionManager = SessionManager.create(options.cwd, getDefaultSessionDir(options.cwd));
  const sessionPath = sessionManager.newSession({
    id: options.sessionId,
    parentSession: options.parentSessionPath,
  });

  if (sessionPath === undefined || sessionPath.length === 0) {
    throw new Error("Failed to allocate child session path");
  }

  persistSessionBootstrap(sessionManager);
  return sessionPath;
}

export function readChildSessionOutcome(sessionPath: string): Promise<ChildSessionOutcome> {
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
        summary = extractedSummary.length > 0 ? extractedSummary : undefined;
        failed = message.stopReason === "error" || message.stopReason === "aborted";
      }

      entry =
        typeof entry.parentId === "string" && entry.parentId.length > 0
          ? sessionManager.getEntry(entry.parentId)
          : undefined;
    }

    return Promise.resolve({
      summary,
      structured,
      structuredError,
      failed: failed || structuredError !== undefined,
    });
  } catch {
    return Promise.resolve({ failed: true });
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

      entry =
        typeof entry.parentId === "string" && entry.parentId.length > 0
          ? sessionManager.getEntry(entry.parentId)
          : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export async function readChildSessionStatus(sessionPath: string): Promise<ChildSessionStatus> {
  return (await readChildSessionStatusDetails(sessionPath)).status;
}

export function readChildSessionStatusDetails(
  sessionPath: string,
): Promise<ChildSessionStatusDetails> {
  try {
    const sessionManager = SessionManager.open(sessionPath);
    let entry = sessionManager.getLeafEntry();

    while (entry) {
      if (entry.type === "message") {
        if (entry.message.role === "assistant") {
          return Promise.resolve({
            status: "idle",
            idleSinceAt: parseTimestampMs(
              (entry as SessionEntry & { timestamp?: unknown }).timestamp,
            ),
          });
        }

        return Promise.resolve({ status: "running" });
      }

      entry =
        typeof entry.parentId === "string" && entry.parentId.length > 0
          ? sessionManager.getEntry(entry.parentId)
          : undefined;
    }
  } catch {
    return Promise.resolve({ status: "running" });
  }

  return Promise.resolve({ status: "running" });
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
  const rewriteFile = readObjectProperty(sessionManager, "_rewriteFile");
  if (typeof rewriteFile !== "function") {
    throw new TypeError("SessionManager bootstrap persistence is unavailable");
  }

  rewriteFile.call(sessionManager);
}

function readObjectProperty<T extends PropertyKey>(target: object, key: T): unknown {
  return hasProperty(target, key) ? target[key] : undefined;
}

function hasProperty<T extends PropertyKey>(
  target: object,
  key: T,
): target is object & Record<T, unknown> {
  return key in target;
}

function getSubagentStateEntry(entry: SessionEntry): SubagentStateEntry | undefined {
  if (entry.type !== "custom" || entry.customType !== SUBAGENT_STATE_ENTRY) {
    return undefined;
  }

  return parseSubagentStateEntry(entry.data);
}
