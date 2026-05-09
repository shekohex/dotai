import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager, getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { extractMessageText } from "../extensions/session-launch-utils.js";
import {
  SUBAGENT_ACTIVITY_ENTRY,
  SUBAGENT_STRUCTURED_OUTPUT_ENTRY,
  StructuredOutputErrorSchema,
  SUBAGENT_STATE_ENTRY,
  parseSubagentActivityEntry,
  parseSubagentStructuredOutputEntry,
  parseSubagentStateEntry,
  type SubagentActivityEntry,
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
import { asRecord, readString } from "../utils/unknown-data.js";
import { Value } from "typebox/value";

type ChildSessionOutcome = {
  summary?: string;
  structured?: unknown;
  structuredError?: StructuredOutputError;
  failed: boolean;
};

type EphemeralChildOutcome = ChildSessionOutcome;

export type ChildSessionStatus = "running" | "idle";

export type ChildSessionStatusDetails = {
  status: ChildSessionStatus;
  idleSinceAt?: number;
};

export const SUBAGENT_PARENT_INPUT_GRACE_MS = 1500;

function resolveAgentDirForSessions(): string {
  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (
    configuredAgentDir !== undefined &&
    configuredAgentDir.length > 0 &&
    configuredAgentDir !== "undefined" &&
    configuredAgentDir !== "null"
  ) {
    return configuredAgentDir;
  }

  const fallbackAgentDir = getAgentDir().trim();
  if (
    fallbackAgentDir.length > 0 &&
    fallbackAgentDir !== "undefined" &&
    fallbackAgentDir !== "null"
  ) {
    return fallbackAgentDir;
  }

  return path.join(os.homedir(), ".pi", "agent");
}

export function getDefaultSessionDir(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replaceAll(/[/\\:]/g, "-")}--`;
  const sessionDir = path.join(resolveAgentDirForSessions(), "sessions", safePath);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function getParentInjectedInputMarkerPath(sessionId: string): string {
  return path.join(os.tmpdir(), "pi-subagent-input", `${sessionId}.json`);
}

export function getAutoExitTimeoutModeMarkerPath(sessionId: string): string {
  return path.join(os.tmpdir(), "pi-subagent-timeout-mode", `${sessionId}.json`);
}

export function getEphemeralChildOutcomePath(sessionId: string): string {
  return path.join(os.tmpdir(), "pi-subagent-outcome", `${sessionId}.json`);
}

function removeFileIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

export function cleanupSubagentPersistenceArtifacts(
  sessionId: string,
  options?: { preserveOutcome?: boolean },
): void {
  removeFileIfPresent(getParentInjectedInputMarkerPath(sessionId));
  removeFileIfPresent(getAutoExitTimeoutModeMarkerPath(sessionId));
  if (options?.preserveOutcome !== true) {
    removeFileIfPresent(getEphemeralChildOutcomePath(sessionId));
  }
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
  persisted?: boolean;
}): string | undefined {
  if (options.persisted === false) {
    return undefined;
  }

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

    const missingOutcome =
      summary === undefined && structured === undefined && structuredError === undefined;

    return Promise.resolve({
      summary,
      structured,
      structuredError,
      failed: failed || structuredError !== undefined || missingOutcome,
    });
  } catch {
    return Promise.resolve({ failed: true });
  }
}

export function readEphemeralChildSessionOutcome(): Promise<ChildSessionOutcome> {
  return Promise.resolve({ failed: true });
}

export function writeEphemeralChildSessionOutcome(
  sessionId: string,
  outcome: EphemeralChildOutcome,
): void {
  const outcomePath = getEphemeralChildOutcomePath(sessionId);

  try {
    fs.mkdirSync(path.dirname(outcomePath), { recursive: true });
    fs.writeFileSync(outcomePath, JSON.stringify(outcome), "utf8");
  } catch {}
}

export function readEphemeralChildSessionOutcomeBySessionId(
  sessionId: string,
): Promise<ChildSessionOutcome> {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(getEphemeralChildOutcomePath(sessionId), "utf8"),
    );
    const outcome = parseEphemeralChildOutcome(raw);
    if (!outcome) {
      return readEphemeralChildSessionOutcome();
    }
    return Promise.resolve({
      summary: outcome.summary,
      structured: outcome.structured,
      structuredError: outcome.structuredError,
      failed: outcome.failed,
    });
  } catch {
    return readEphemeralChildSessionOutcome();
  }
}

function parseEphemeralChildOutcome(value: unknown): EphemeralChildOutcome | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const failed = record.failed;
  if (typeof failed !== "boolean") {
    return undefined;
  }

  const summary = readString(record.summary);
  const structuredError = Value.Check(StructuredOutputErrorSchema, record.structuredError)
    ? Value.Parse(StructuredOutputErrorSchema, record.structuredError)
    : undefined;

  return {
    summary,
    structured: record.structured,
    structuredError,
    failed,
  };
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

export function readLatestChildActivityState(
  sessionPath: string,
): SubagentActivityEntry | undefined {
  try {
    const sessionManager = SessionManager.open(sessionPath);
    let entry = sessionManager.getLeafEntry();

    while (entry) {
      if (entry.type === "custom" && entry.customType === SUBAGENT_ACTIVITY_ENTRY) {
        return parseSubagentActivityEntry(entry.data);
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

export function readEphemeralChildSessionStatusDetails(): Promise<ChildSessionStatusDetails> {
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
      activity:
        state.sessionPath === undefined
          ? undefined
          : readLatestChildActivityState(state.sessionPath),
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
