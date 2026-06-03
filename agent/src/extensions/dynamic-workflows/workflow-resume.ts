import { readChildSessionOutcome } from "../../subagent-sdk/persistence.js";
import {
  createCompletedJournalEntry,
  type AgentJournalInput,
  type CompletedJournalEntry,
  type FailedJournalEntry,
  type JournalEntry,
} from "./workflow-journal.js";

export interface ResumeSessionRef {
  sessionId: string;
  sessionPath: string;
}

export function getResumeSession(
  cached: JournalEntry | undefined,
  callHash: string,
): ResumeSessionRef | undefined {
  if (cached?.hash !== callHash) return undefined;
  if (cached.status === "started")
    return { sessionId: cached.sessionId, sessionPath: cached.sessionPath };
  if (cached.status !== "failed" || !cached.retryable) return undefined;
  return cached.sessionId !== undefined && cached.sessionPath !== undefined
    ? { sessionId: cached.sessionId, sessionPath: cached.sessionPath }
    : undefined;
}

export async function getStartedSessionCompletedEntry(
  cached: JournalEntry | undefined,
  callHash: string,
  input: AgentJournalInput & { structured: boolean },
): Promise<CompletedJournalEntry | undefined> {
  if (cached?.hash !== callHash || cached.status !== "started") return undefined;
  const outcome = await readChildSessionOutcome(cached.sessionPath);
  if (outcome.failed) return undefined;
  const result = input.structured ? outcome.structured : outcome.summary;
  if (result === undefined) return undefined;
  return createCompletedJournalEntry(
    { ...input, sessionId: cached.sessionId, sessionPath: cached.sessionPath },
    result,
    0,
  );
}

export function isCachedNonRetryableFailure(
  cached: JournalEntry | undefined,
  callHash: string,
): cached is FailedJournalEntry {
  return cached?.hash === callHash && cached.status === "failed" && !cached.retryable;
}

export function isCachedFailedAgent(
  cached: JournalEntry | undefined,
  callHash: string,
): cached is FailedJournalEntry {
  return cached?.hash === callHash && cached.status === "failed";
}
