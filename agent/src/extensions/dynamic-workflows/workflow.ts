import vm from "node:vm";
import type { Expression, Literal } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { RuntimeSubagent } from "../../subagent-sdk/types.js";
import type { AgentUsage } from "./agent.js";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.js";
import type { WorkflowAgentActivityEvent } from "./display.js";
import { isRetryableWorkflowError, WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import {
  createCompletedJournalEntry,
  createFailedJournalEntry,
  createStartedJournalEntry,
  type AgentJournalInput,
  type JournalEntry,
} from "./workflow-journal.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModeRoutingFromMeta, resolveModeForPhase } from "./mode-routing.js";
import {
  getResumeSession,
  getStartedSessionCompletedEntry,
  isCachedFailedAgent,
} from "./workflow-resume.js";
import { getDynamicWorkflowSettings } from "./settings.js";
import {
  buildAgentInstructions,
  createParallelFunction,
  createPipelineFunction,
  createLimiter,
  defaultAgentLabel,
  estimateTokens,
  hashAgentCall,
  withTimeout,
} from "./workflow-utils.js";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.js";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  mode?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export type { JournalEntry } from "./workflow-journal.js";

export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number };
  depth: number;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  mainModel?: string;
  concurrency?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  maxAgents?: number;
  agentTimeoutMs?: number;
  persistLogs?: boolean;
  runId?: string;
  resumeJournal?: Map<number, JournalEntry>;
  resumeFromRunId?: string;
  onAgentJournal?: (entry: JournalEntry) => void;
  sharedRuntime?: SharedRuntime;
  loadSavedWorkflow?: (name: string) => string | undefined;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { label: string; phase?: string; prompt: string; model?: string }) => void;
  onAgentActivity?: (event: {
    label: string;
    phase?: string;
    activity: WorkflowAgentActivityEvent;
  }) => void;
  onAgentEnd?: (event: {
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    worktree?: string;
    model?: string;
  }) => void;
  onTokenUsage?: (usage: { input: number; output: number; total: number; cost: number }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
}

export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  mode?: string;
  outputRetryCount?: number;
  toolNames?: string[];
  isolation?: "worktree";
  agentType?: string;
  timeoutMs?: number;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  callSeq: number;
}

type WorkflowLogger = ReturnType<typeof createWorkflowLogger>;

export interface WorkflowExecution {
  started: number;
  meta: WorkflowMeta;
  body: string;
  routingConfig: ReturnType<typeof parseModeRoutingFromMeta>;
  maxAgents: number;
  agentTimeoutMs: number;
  runId: string;
  baseCwd: string;
  logger: WorkflowLogger;
  state: RuntimeState;
  agentRunner: Pick<WorkflowAgent, "run">;
  shared: SharedRuntime;
  log: (message: string) => void;
  phase: (title: string) => void;
  budget: Readonly<{
    total: number | null;
    spent: () => number;
    remaining: () => number;
  }>;
  throwIfAborted: () => void;
}

interface LiveAgentCall {
  prompt: string;
  agentOptions: AgentOptions;
  assignedPhase: string | undefined;
  callIndex: number;
  label: string;
  modeName: string | undefined;
  displayModel: string | undefined;
  resumeSession?: { sessionId: string; sessionPath: string };
}

const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

function parseWorkflowErrorCode(value: string | undefined): WorkflowErrorCode {
  if (value === WorkflowErrorCode.AGENT_TIMEOUT) return WorkflowErrorCode.AGENT_TIMEOUT;
  if (value === WorkflowErrorCode.WORKFLOW_ABORTED) return WorkflowErrorCode.WORKFLOW_ABORTED;
  if (value === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED)
    return WorkflowErrorCode.AGENT_LIMIT_EXCEEDED;
  if (value === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED)
    return WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED;
  if (value === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR)
    return WorkflowErrorCode.SCRIPT_VALIDATION_ERROR;
  if (value === WorkflowErrorCode.AGENT_EXECUTION_ERROR)
    return WorkflowErrorCode.AGENT_EXECUTION_ERROR;
  if (value === WorkflowErrorCode.PERSISTENCE_ERROR) return WorkflowErrorCode.PERSISTENCE_ERROR;
  return WorkflowErrorCode.UNKNOWN;
}

function createWorkflowFailedJournalEntry(
  journalInput: AgentJournalInput,
  failedSession: { sessionId: string; sessionPath: string } | undefined,
  workflowError: WorkflowError,
): JournalEntry {
  return createFailedJournalEntry(
    { ...journalInput, ...failedSession },
    workflowError.message,
    isRetryableWorkflowError(workflowError),
    workflowError.code,
    workflowError.recoverable,
  );
}

export function runWorkflow(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  return runWorkflowInternal(script, options);
}

function runWorkflowInternal(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  return executeWorkflow(createWorkflowExecution(script, options), options);
}

function createWorkflowExecution(script: string, options: WorkflowRunOptions): WorkflowExecution {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const settings = getDynamicWorkflowSettings();
  const routingConfig = parseModeRoutingFromMeta(meta.phases);
  const maxAgents = options.maxAgents ?? settings.maxAgents ?? MAX_AGENTS_PER_RUN;
  const agentTimeoutMs =
    options.agentTimeoutMs ?? settings.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const runId = options.runId ?? `run-${started.toString(36)}`;
  const baseCwd = options.cwd ?? process.cwd();
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? settings.persistLogs,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    phases: [],
    callSeq: 0,
  };
  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = Math.max(
    1,
    Math.min(
      options.concurrency ??
        settings.concurrency ??
        Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
      MAX_CONCURRENCY,
    ),
  );
  const shared: SharedRuntime = options.sharedRuntime ?? {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0 },
    depth: 0,
  };
  const log = (message: string) => {
    const text = message;
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    options.onPhase?.(title);
  };
  const tokenBudget = options.tokenBudget ?? settings.tokenBudget;

  const budget = Object.freeze({
    total: tokenBudget,
    spent: () => shared.spent,
    remaining: () =>
      tokenBudget === null || tokenBudget === undefined
        ? Infinity
        : Math.max(0, tokenBudget - shared.spent),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted === true) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, {
        recoverable: true,
      });
    }
  };

  return {
    started,
    meta,
    body,
    routingConfig,
    maxAgents,
    agentTimeoutMs,
    runId,
    baseCwd,
    logger,
    state,
    agentRunner,
    shared,
    log,
    phase,
    budget,
    throwIfAborted,
  };
}

async function executeWorkflow(
  execution: WorkflowExecution,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult> {
  const agent = createAgentFunction(execution, options);
  const parallel = createParallelFunction(execution, options);
  const pipeline = createPipelineFunction(execution, options);
  const workflowFn = createNestedWorkflowFunction(execution, options);
  const result = await executeWorkflowBody(execution, options, {
    agent,
    parallel,
    pipeline,
    workflow: workflowFn,
  });

  execution.logger.persist();

  options.onTokenUsage?.(execution.shared.tokenUsage);

  return {
    meta: execution.meta,
    result,
    logs: execution.state.logs,
    phases: execution.state.phases,
    agentCount: execution.shared.agentCount,
    durationMs: Date.now() - execution.started,
    runId: execution.runId,
    tokenUsage: execution.shared.tokenUsage,
  };
}

function createAgentFunction(execution: WorkflowExecution, options: WorkflowRunOptions) {
  return async (prompt: string, agentOptions: AgentOptions = {}) => {
    execution.throwIfAborted();

    if (execution.shared.agentCount >= execution.maxAgents) {
      throw new WorkflowError(
        `Agent limit exceeded (${execution.maxAgents}). Use maxAgents option to increase the limit.`,
        WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }

    if (execution.budget.total !== null && execution.budget.remaining() <= 0) {
      throw new WorkflowError(
        "workflow token budget exhausted",
        WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
        { recoverable: false },
      );
    }

    const assignedPhase = agentOptions.phase ?? execution.state.currentPhase;
    const requestedLabel = agentOptions.label?.trim();
    const modeName =
      agentOptions.mode ?? resolveModeForPhase(assignedPhase, execution.routingConfig);
    const displayModel = modeName ?? options.mainModel;
    const callIndex = execution.state.callSeq++;
    const callHash = hashAgentCall(prompt, modeName, assignedPhase, agentOptions);
    const cached = options.resumeJournal?.get(callIndex);
    const label =
      requestedLabel ?? defaultAgentLabel(assignedPhase, execution.shared.agentCount + 1);
    const journalInput: AgentJournalInput = {
      index: callIndex,
      hash: callHash,
      label,
      phase: assignedPhase,
      prompt,
      mode: modeName,
      model: displayModel,
    };
    const completedStartedEntry = await getStartedSessionCompletedEntry(cached, callHash, {
      ...journalInput,
      structured: agentOptions.schema !== undefined,
    });
    const completedEntry =
      cached?.hash === callHash && cached.status === "completed" ? cached : completedStartedEntry;
    if (completedEntry !== undefined) {
      execution.shared.agentCount++;
      options.onAgentStart?.({ label, phase: assignedPhase, prompt, model: displayModel });
      if (completedEntry === completedStartedEntry) options.onAgentJournal?.(completedEntry);
      options.onAgentEnd?.({
        label,
        phase: assignedPhase,
        result: completedEntry.result,
        tokens: 0,
        model: displayModel,
      });
      return completedEntry.result;
    }
    if (isCachedFailedAgent(cached, callHash) && !cached.retryable) {
      if (cached.recoverable === false) {
        throw new WorkflowError(cached.error, parseWorkflowErrorCode(cached.code), {
          recoverable: false,
        });
      }
      execution.shared.agentCount++;
      options.onAgentStart?.({ label, phase: assignedPhase, prompt, model: displayModel });
      options.onAgentEnd?.({
        label,
        phase: assignedPhase,
        result: null,
        tokens: 0,
        model: displayModel,
      });
      return null;
    }
    const resumeSession = getResumeSession(cached, callHash);

    return execution.shared.limiter(() =>
      runLiveAgentCall(execution, options, {
        prompt,
        agentOptions,
        assignedPhase,
        callIndex,
        label,
        modeName,
        displayModel,
        resumeSession,
      }),
    );
  };
}

async function runLiveAgentCall(
  execution: WorkflowExecution,
  options: WorkflowRunOptions,
  call: LiveAgentCall,
): Promise<unknown> {
  execution.shared.agentCount++;
  const displayModel = call.displayModel;
  const timeout = call.agentOptions.timeoutMs ?? execution.agentTimeoutMs;
  options.onAgentStart?.({
    label: call.label,
    phase: call.assignedPhase,
    prompt: call.prompt,
    model: displayModel,
  });

  let worktree: Worktree | undefined;
  if (call.agentOptions.isolation === "worktree") {
    worktree = await createWorktree(
      execution.baseCwd,
      `${execution.runId}-${call.callIndex}-${call.label}`,
    );
    if (!worktree.isolated)
      execution.log(`isolation ignored for "${call.label}" (${worktree.reason})`);
  }
  const runCwd = worktree?.isolated === true ? worktree.cwd : undefined;
  let usage: AgentUsage | undefined;
  const recordTokens = (result: unknown): number => {
    const tokens =
      usage && usage.total > 0 ? usage.total : estimateTokens(result) + estimateTokens(call.prompt);
    if (usage) {
      execution.shared.tokenUsage.input += usage.input;
      execution.shared.tokenUsage.output += usage.output;
      execution.shared.tokenUsage.cost += usage.cost;
    }
    execution.shared.tokenUsage.total += tokens;
    execution.shared.spent += tokens;
    return tokens;
  };
  const journalHash = hashAgentCall(
    call.prompt,
    call.modeName,
    call.assignedPhase,
    call.agentOptions,
  );
  const journalInput: AgentJournalInput = {
    index: call.callIndex,
    hash: journalHash,
    label: call.label,
    phase: call.assignedPhase,
    prompt: call.prompt,
    mode: call.modeName,
    model: displayModel,
  };
  let childSession: { sessionId: string; sessionPath: string } | undefined;

  try {
    execution.throwIfAborted();
    const resumeSession =
      call.agentOptions.isolation === "worktree" ? undefined : call.resumeSession;
    const result = await withTimeout(
      runWorkflowAgent(execution.agentRunner, call.prompt, call.agentOptions, {
        label: call.label,
        signal: options.signal,
        instructions: buildAgentInstructions(call.assignedPhase, call.agentOptions),
        mode: call.modeName,
        outputRetryCount: call.agentOptions.outputRetryCount,
        toolNames: call.agentOptions.toolNames,
        cwd: runCwd,
        resumeSession,
        onUsage: (u: AgentUsage) => {
          usage = u;
        },
        onActivity: (activity: WorkflowAgentActivityEvent) => {
          options.onAgentActivity?.({
            label: call.label,
            phase: call.assignedPhase,
            activity,
          });
        },
        onStart: (state: RuntimeSubagent) => {
          if (state.sessionPath === undefined) return;
          childSession = { sessionId: state.sessionId, sessionPath: state.sessionPath };
          options.onAgentJournal?.(createStartedJournalEntry({ ...journalInput, ...childSession }));
        },
      }),
      timeout,
      `Agent "${call.label}" timed out after ${timeout}ms`,
    );
    execution.throwIfAborted();
    const tokens = recordTokens(result);
    options.onAgentJournal?.(
      createCompletedJournalEntry({ ...journalInput, ...childSession }, result, tokens),
    );
    options.onAgentEnd?.({
      label: call.label,
      phase: call.assignedPhase,
      result,
      tokens,
      worktree: runCwd,
      model: displayModel,
    });
    return result;
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    const workflowError = wrapError(error, { agentLabel: call.label });
    const failedSession =
      workflowError.code === WorkflowErrorCode.AGENT_TIMEOUT ? undefined : childSession;
    options.onAgentJournal?.(
      createWorkflowFailedJournalEntry(journalInput, failedSession, workflowError),
    );
    execution.logger.error(`agent ${call.label} failed: ${workflowError.message}`);
    const tokens = recordTokens(null);
    options.onAgentEnd?.({
      label: call.label,
      phase: call.assignedPhase,
      result: null,
      tokens,
      worktree: runCwd,
    });
    if (workflowError.recoverable) return null;
    throw workflowError;
  } finally {
    if (worktree?.isolated === true) await removeWorktree(worktree);
  }
}

function runWorkflowAgent(
  agentRunner: Pick<WorkflowAgent, "run">,
  prompt: string,
  agentOptions: AgentOptions,
  runOptions: Omit<Parameters<WorkflowAgent["run"]>[1], "schema">,
): Promise<unknown> {
  if (agentOptions.schema === undefined) return agentRunner.run(prompt, runOptions);
  return agentRunner.run(prompt, { ...runOptions, schema: agentOptions.schema });
}

function createNestedWorkflowFunction(execution: WorkflowExecution, options: WorkflowRunOptions) {
  return async (nameOrScript: string, childArgs?: unknown): Promise<unknown> => {
    execution.throwIfAborted();
    if (execution.shared.depth >= 1) {
      throw new WorkflowError(
        "workflow() can nest only one level deep",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }
    const childScript = options.loadSavedWorkflow?.(nameOrScript) ?? nameOrScript;
    execution.shared.depth++;
    try {
      const child = await runWorkflow(childScript, {
        ...options,
        args: childArgs,
        sharedRuntime: execution.shared,
        resumeJournal: undefined,
        resumeFromRunId: undefined,
        runId: `${execution.runId}-nested${execution.shared.depth}`,
        persistLogs: false,
      });
      return child.result;
    } finally {
      execution.shared.depth--;
    }
  };
}

async function executeWorkflowBody(
  execution: WorkflowExecution,
  options: WorkflowRunOptions,
  helpers: {
    agent: ReturnType<typeof createAgentFunction>;
    parallel: ReturnType<typeof createParallelFunction>;
    pipeline: ReturnType<typeof createPipelineFunction>;
    workflow: ReturnType<typeof createNestedWorkflowFunction>;
  },
): Promise<unknown> {
  const context = vm.createContext({
    ...helpers,
    log: execution.log,
    phase: execution.phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget: execution.budget,
    console: {
      log: execution.log,
      info: execution.log,
      warn: (message: unknown) => {
        execution.log(`[warn] ${String(message)}`);
      },
      error: (message: unknown) => {
        execution.log(`[error] ${String(message)}`);
      },
    },
    JSON,
    Math,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
  });

  const wrapped = `(async () => {\n${execution.body}\n})()`;
  return await new vm.Script(wrapped, {
    filename: `${execution.meta.name || "workflow"}.js`,
  }).runInContext(context);
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  if (DETERMINISM_BLOCKLIST.test(script)) {
    throw new WorkflowError(
      "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  });

  const first = ast.body[0];
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError(
      "meta export must declare only `meta`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }

  const declarator = declaration.declarations[0];
  if (declarator?.id.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError(
      "meta export must declare `meta`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declarator.init === null || declarator.init === undefined)
    throw new WorkflowError(
      "meta must have a literal value",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: Expression | Literal, path: string): unknown {
  if (node.type === "ObjectExpression") {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
      if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
      if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
      if (prop.kind !== "init" || prop.method)
        throw new Error(`methods/accessors not allowed in ${path}`);
      const key = propertyKey(prop.key, path);
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error(`reserved key name not allowed in ${path}: ${key}`);
      }
      out[key] = evaluateLiteral(prop.value, `${path}.${key}`);
    }
    return out;
  }
  if (node.type === "ArrayExpression") {
    return node.elements.map((element, index) => {
      if (element === null) throw new Error(`sparse arrays not allowed in ${path}`);
      if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
      return evaluateLiteral(element, `${path}[${index}]`);
    });
  }
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral") {
    if (node.expressions.length > 0)
      throw new Error(`template interpolation not allowed in ${path}`);
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  if (node.type === "UnaryExpression") {
    if (
      node.operator === "-" &&
      node.argument?.type === "Literal" &&
      typeof node.argument.value === "number"
    ) {
      return -node.argument.value;
    }
    throw new Error(`only negative-number unary allowed in ${path}`);
  }
  throw new Error(`non-literal node type in ${path}: ${node.type}`);
}

function propertyKey(node: Expression, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (meta === null || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta;
  if (!("name" in value) || typeof value.name !== "string" || value.name.trim() === "")
    throw new Error("meta.name must be a non-empty string");
  if (
    !("description" in value) ||
    typeof value.description !== "string" ||
    value.description.trim() === ""
  )
    throw new Error("meta.description must be a non-empty string");
  if ("whenToUse" in value && value.whenToUse !== undefined && typeof value.whenToUse !== "string")
    throw new Error("meta.whenToUse must be a string");
  const phases: unknown = "phases" in value ? value.phases : undefined;
  if (phases !== undefined) {
    if (!Array.isArray(phases)) throw new Error("meta.phases must be an array");
    for (const phase of phases) {
      if (!hasMetaPhaseTitle(phase)) {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function hasMetaPhaseTitle(phase: unknown): phase is { title: string } {
  return (
    phase !== null &&
    typeof phase === "object" &&
    "title" in phase &&
    typeof phase.title === "string"
  );
}
