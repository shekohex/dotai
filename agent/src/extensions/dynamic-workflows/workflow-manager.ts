/** Workflow manager for background execution, pause/resume, and run management. */

import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../utils/error-message.js";
import { asRecord } from "../../utils/unknown-data.js";
import type { WorkflowAgent, WorkflowSubagentBackend } from "./agent.js";
import { preview, type WorkflowAgentActivityEvent, type WorkflowSnapshot } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { getDynamicWorkflowSettings } from "./settings.js";
import {
  createRunPersistence,
  generateRunId,
  type PersistedRunState,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import {
  type JournalEntry,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowRunResult,
} from "./workflow.js";

const ResumableBlockedWorkflowResultSchema = Type.Object(
  {
    ok: Type.Literal(false),
    status: Type.Literal("blocked"),
  },
  { additionalProperties: true },
);

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /**
   * True when the run was started in the background (or resumed) and the caller is not awaiting its
   * result inline. Only background runs deliver their result back into the conversation; a
   * foreground sync run already returns it as the tool result, so re-delivering would duplicate
   * it.
   */
  background: boolean;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. */
  agentTimeoutMs?: number;
  /** Runtime backend for workflow subagents. */
  subagentBackend?: WorkflowSubagentBackend;
  runId?: string;
  displayName?: string;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  pi?: ExtensionAPI;
  ctx?: ExtensionContext;
  /** Parent session model label shown for agents that use default routing. */
  mainModel?: string;
  /** Default runtime backend for workflow subagents. */
  subagentBackend?: WorkflowSubagentBackend;
}

function mergeAgentActivityEvents(
  events: WorkflowAgentActivityEvent[] | undefined,
  nextEvent: WorkflowAgentActivityEvent,
): WorkflowAgentActivityEvent[] {
  const activityEvents = [...(events ?? [])];
  if (nextEvent.kind !== "tool_end" || nextEvent.toolName === undefined) {
    return [...activityEvents, nextEvent].slice(-30);
  }

  const matchingStartIndex = activityEvents.findLastIndex(
    (activity) =>
      activity.kind === "tool_start" &&
      activity.toolName === nextEvent.toolName &&
      activity.done !== true,
  );
  if (matchingStartIndex < 0) {
    return [...activityEvents, nextEvent].slice(-30);
  }

  activityEvents[matchingStartIndex] = {
    ...activityEvents[matchingStartIndex],
    done: true,
    timestamp: nextEvent.timestamp,
  };
  return activityEvents.slice(-30);
}

function createResumeJournalMap(journal: JournalEntry[]): Map<number, JournalEntry> {
  const entries = new Map<number, JournalEntry>();
  for (const entry of journal) {
    const existing = entries.get(entry.index);
    if (existing === undefined || existing.status !== "completed" || entry.status === "completed") {
      entries.set(entry.index, mergeJournalEntry(existing, entry));
    }
  }
  return entries;
}

function workflowRunStatus(result: unknown): RunStatus {
  return Value.Check(ResumableBlockedWorkflowResultSchema, result) ? "blocked" : "completed";
}

function mergeWorkflowArgs(args: unknown, resumeArgs: unknown): unknown {
  if (resumeArgs === undefined) return args;
  const argsRecord = asRecord(args);
  const resumeArgsRecord = asRecord(resumeArgs);
  if (argsRecord !== undefined && resumeArgsRecord !== undefined) {
    return { ...argsRecord, ...resumeArgsRecord };
  }
  return resumeArgs;
}

export function mergeJournalEntry(
  existing: JournalEntry | undefined,
  entry: JournalEntry,
): JournalEntry {
  if (entry.status === "started") return entry;
  const matchingExisting = existing?.hash === entry.hash ? existing : undefined;
  if (entry.status === "completed") {
    const sessionId = entry.sessionId ?? matchingExisting?.sessionId;
    const sessionPath = entry.sessionPath ?? matchingExisting?.sessionPath;
    const paneId = entry.paneId ?? matchingExisting?.paneId;
    const muxBackend = entry.muxBackend ?? matchingExisting?.muxBackend;
    return { ...entry, sessionId, sessionPath, paneId, muxBackend };
  }
  return entry;
}

// eslint-disable-next-line unicorn/prefer-event-target
export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  private pi?: ExtensionAPI;
  private ctx?: ExtensionContext;
  /** Parent session model label shown for agents that use default routing. */
  private mainModel?: string;
  private subagentBackend?: WorkflowSubagentBackend;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    const settings = getDynamicWorkflowSettings();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? settings.concurrency;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.pi = options.pi;
    this.ctx = options.ctx;
    this.mainModel = options.mainModel;
    this.subagentBackend = options.subagentBackend;
    this.persistence = createRunPersistence(this.cwd);
  }

  /*
   * Set the parent session model label used in workflow displays.
   * @param spec Model spec.
   */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  setExtensionContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  /*
   * Start a workflow in the background. Returns immediately with a run ID; the workflow executes
   * asynchronously.
   * @param script Workflow script.
   * @param args Workflow args.
   * @returns Background run handle.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: Pick<ExecOptions, "subagentBackend" | "runId" | "displayName"> = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const runId = exec.runId ?? generateRunId();
    const controller = new AbortController();
    const parsed = parseWorkflowScript(script);
    const workflowName = exec.displayName ?? parsed.meta.name;

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: workflowName,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: true,
    };

    this.runs.set(runId, managed);

    // Persist initial state
    this.persistence.save({
      runId,
      workflowName,
      script,
      args,
      status: "running",
      phases: managed.snapshot.phases,
      agents: [],
      logs: [],
      startedAt: managed.startedAt.toISOString(),
      updatedAt: managed.startedAt.toISOString(),
    });

    // Run workflow asynchronously
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /*
   * Execute a workflow synchronously (blocking) while still tracking it like a background run, so
   * the `/workflows` navigator and the live task panel see it. `onProgress` fires on every progress
   * event with the current snapshot, letting a caller (e.g. the workflow tool) drive its own inline
   * display.
   * @param script Workflow script.
   * @param args Workflow args.
   * @param exec Execution options.
   * @returns Workflow result.
   */
  runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.createManaged(script, args);
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.executeRun(managed, script, args, exec);
  }

  /*
   * Build a fresh managed run with an empty snapshot.
   * @param script Workflow script.
   * @param args Workflow args.
   * @returns Managed run.
   */
  private createManaged(script: string, args?: unknown): ManagedRun {
    const parsed = parseWorkflowScript(script);
    return {
      runId: generateRunId(),
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: false,
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const { resumeJournal, maxAgents, agentTimeoutMs, externalSignal, onProgress } = exec;
    const progress = () => onProgress?.(managed.snapshot);
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else
        externalSignal.addEventListener(
          "abort",
          () => {
            managed.controller.abort();
          },
          { once: true },
        );
    }
    try {
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        pi: this.pi,
        ctx: this.ctx,
        args,
        agent: this.agent,
        mainModel: this.mainModel,
        signal: managed.controller.signal,
        concurrency: this.concurrency,
        maxAgents,
        agentTimeoutMs,
        subagentBackend: exec.subagentBackend ?? this.subagentBackend,
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        onAgentJournal: (entry) => {
          const existing = managed.journal.find((candidate) => candidate.index === entry.index);
          managed.journal = managed.journal.filter((candidate) => candidate.index !== entry.index);
          managed.journal.push(mergeJournalEntry(existing, entry));
          this.persistRun(managed);
        },
        onLog: (message) => {
          managed.snapshot.logs.push(message);
          this.emit("log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emit("phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          managed.snapshot.agents.push({
            id: managed.snapshot.agents.length + 1,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
            activity: "starting",
            activityEvents: [],
          });
          this.emit("agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentActivity: (event) => {
          const agent = [...managed.snapshot.agents]
            .toReversed()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.activity = event.activity.label;
            agent.activityEvents = mergeAgentActivityEvents(agent.activityEvents, event.activity);
          }
          this.emit("agentActivity", { runId: managed.runId, ...event });
          progress();
        },
        onAgentEnd: (event) => {
          const agent = [...managed.snapshot.agents]
            .toReversed()
            .find((a) => a.label === event.label && a.status === "running");
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            agent.resultPreview = preview(event.result);
            agent.tokens = event.tokens;
            agent.activity = agent.status === "error" ? "failed" : "completed";
            if (event.model !== undefined && event.model.length > 0) agent.model = event.model;
          }
          this.emit("agentEnd", { runId: managed.runId, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          managed.snapshot.tokenUsage = usage;
          this.emit("tokenUsage", { runId: managed.runId, usage });
          progress();
        },
      });

      managed.status = workflowRunStatus(result.result);
      managed.result = result;
      this.emit("complete", { runId: managed.runId, result });

      // Persist final state
      this.persistRun(managed);

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(errorMessage(error), WorkflowErrorCode.WORKFLOW_ABORTED, {
              recoverable: true,
            });

      const cancelledByControl = managed.status === "paused" || managed.status === "aborted";
      if (!cancelledByControl && managed.controller.signal.aborted) {
        managed.status = "aborted";
      } else if (!cancelledByControl) {
        managed.status = "failed";
      }
      managed.error = workflowError;
      if (!cancelledByControl) this.emitWorkflowError(managed.runId, workflowError);

      // Persist final state
      this.persistRun(managed);

      throw workflowError;
    }
  }

  private emitWorkflowError(runId: string, error: WorkflowError): void {
    if (this.listenerCount("error") === 0) return;
    this.emit("error", { runId, error });
  }

  private persistRun(managed: ManagedRun) {
    this.persistence.save({
      runId: managed.runId,
      workflowName: managed.snapshot.name,
      // Persist the real script + journal so the run can be resumed. Runs live
      // under .pi/workflows/runs/ — protect via directory permissions, not blanking.
      script: managed.script,
      args: managed.args,
      journal: managed.journal,
      status: managed.status,
      phases: managed.snapshot.phases,
      currentPhase: managed.snapshot.currentPhase,
      agents: managed.snapshot.agents.map((a) => ({
        id: a.id,
        label: a.label,
        phase: a.phase,
        prompt: a.prompt,
        status: a.status,
        result: a.resultPreview,
        error: a.error,
        model: a.model,
        startedAt: managed.startedAt.toISOString(),
        endedAt: new Date().toISOString(),
      })),
      logs: managed.snapshot.logs,
      result: managed.result?.result,
      tokenUsage: managed.snapshot.tokenUsage
        ? {
            input: managed.snapshot.tokenUsage.input,
            output: managed.snapshot.tokenUsage.output,
            total: managed.snapshot.tokenUsage.total,
          }
        : undefined,
      startedAt: managed.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
      durationMs: managed.result?.durationMs,
    });
  }

  /*
   * Pause a running workflow.
   * @param runId Run ID.
   * @returns Whether run was paused.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    this.emit("paused", { runId });
    this.persistRun(managed);
    return true;
  }

  /*
   * Resume an interrupted run: replay journaled results for the unchanged prefix and run the rest
   * live. Returns false if there is nothing resumable.
   * @param runId Run ID.
   * @returns Whether run was resumed.
   */
  resume(runId: string): boolean {
    return this.resumeInBackground(runId) !== false;
  }

  resumeInBackground(
    runId: string,
    resumeArgs?: unknown,
  ): { runId: string; promise: Promise<WorkflowRunResult> } | false {
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;

    const persisted = this.persistence.load(runId);
    if (
      persisted?.script === undefined ||
      persisted.script.length === 0 ||
      persisted.status === "completed"
    )
      return false;

    const controller = new AbortController();
    const args = mergeWorkflowArgs(persisted.args, resumeArgs);
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script: persisted.script,
      args,
      journal: persisted.journal ?? [],
      background: true,
    };
    this.runs.set(runId, managed);

    const resumeJournal = createResumeJournalMap(persisted.journal ?? []);
    this.emit("resumed", { runId });
    const promise = this.executeRun(managed, persisted.script, args, { resumeJournal });
    promise.catch(() => {});
    return { runId, promise };
  }

  /*
   * Stop a running workflow.
   * @param runId Run ID.
   * @returns Whether run was stopped.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;

    managed.controller.abort();
    managed.status = "aborted";
    this.emit("stopped", { runId });
    this.persistRun(managed);
    return true;
  }

  /*
   * Get status of a specific run.
   * @param runId Run ID.
   * @returns Managed run when active.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /*
   * List all runs (active + persisted).
   * @returns Persisted run states.
   */
  listRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /*
   * Get snapshot of a run.
   * @param runId Run ID.
   * @returns Snapshot when active.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /*
   * Delete a persisted run.
   * @param runId Run ID.
   * @returns Whether persisted run was deleted.
   */
  deleteRun(runId: string): boolean {
    this.runs.delete(runId);
    return this.persistence.delete(runId);
  }

  /*
   * Get the persistence layer (for saving workflows).
   * @returns Persistence layer.
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
