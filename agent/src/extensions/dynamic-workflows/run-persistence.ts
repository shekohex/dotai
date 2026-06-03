/** Workflow run state persistence for pause/resume support. */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { WORKFLOW_RUNS_DIR } from "./config.js";
import { JournalEntrySchema, type JournalEntry } from "./workflow-journal.js";

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "blocked"
  | "failed"
  | "aborted";

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  status: RunStatus;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  /** Agent call lifecycle records for resume, keyed by deterministic call index. */
  journal?: JournalEntry[];
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /** Get runs directory path. */
  getRunsDir(): string;
}

const PersistedAgentStateSchema = Type.Object({
  id: Type.Number(),
  label: Type.String(),
  phase: Type.Optional(Type.String()),
  prompt: Type.String(),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("done"),
    Type.Literal("error"),
    Type.Literal("skipped"),
  ]),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

const PersistedRunStateSchema = Type.Object({
  runId: Type.String(),
  workflowName: Type.String(),
  script: Type.String(),
  args: Type.Optional(Type.Unknown()),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("completed"),
    Type.Literal("blocked"),
    Type.Literal("failed"),
    Type.Literal("aborted"),
  ]),
  phases: Type.Array(Type.String()),
  currentPhase: Type.Optional(Type.String()),
  agents: Type.Array(PersistedAgentStateSchema),
  logs: Type.Array(Type.String()),
  result: Type.Optional(Type.Unknown()),
  startedAt: Type.String(),
  updatedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Number()),
  tokenUsage: Type.Optional(
    Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      total: Type.Number(),
    }),
  ),
  journal: Type.Optional(Type.Unknown()),
});

function parsePersistedRunState(text: string): PersistedRunState | null {
  const parsed: unknown = JSON.parse(text);
  if (!Value.Check(PersistedRunStateSchema, parsed)) return null;
  const state = Value.Parse(PersistedRunStateSchema, parsed);
  const journal = Array.isArray(state.journal)
    ? state.journal.filter((entry): entry is JournalEntry => Value.Check(JournalEntrySchema, entry))
    : undefined;
  const { journal: _journal, ...stateWithoutJournal } = state;
  return journal === undefined ? stateWithoutJournal : { ...stateWithoutJournal, journal };
}

export function createRunPersistence(cwd: string): RunPersistence {
  const runsDir = join(cwd, WORKFLOW_RUNS_DIR);

  const ensureDir = () => {
    if (!existsSync(runsDir)) {
      mkdirSync(runsDir, { recursive: true });
    }
  };

  const runPath = (runId: string) => join(runsDir, `${runId}.json`);

  return {
    save(state: PersistedRunState) {
      ensureDir();
      state.updatedAt = new Date().toISOString();
      writeFileSync(runPath(state.runId), JSON.stringify(state, null, 2));
    },

    load(runId: string): PersistedRunState | null {
      try {
        const path = runPath(runId);
        if (!existsSync(path)) return null;
        return parsePersistedRunState(readFileSync(path, "utf-8"));
      } catch {
        return null;
      }
    },

    list(): PersistedRunState[] {
      ensureDir();
      try {
        const files = readdirSync(runsDir).filter((f) => f.endsWith(".json"));
        const runs: PersistedRunState[] = [];
        for (const file of files) {
          try {
            const state = parsePersistedRunState(readFileSync(join(runsDir, file), "utf-8"));
            if (state !== null) runs.push(state);
          } catch {
            // Skip corrupted files
          }
        }
        return runs.toSorted(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
      } catch {
        return [];
      }
    },

    delete(runId: string): boolean {
      try {
        const path = runPath(runId);
        if (existsSync(path)) {
          unlinkSync(path);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
}

/**
 * Generate a unique run ID.
 *
 * @returns {string} Unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
