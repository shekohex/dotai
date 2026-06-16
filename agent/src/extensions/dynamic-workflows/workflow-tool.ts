import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  defineTool,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../utils/error-message.js";
import { applyLinePrefix, createTextComponent, formatToolRail } from "../coreui/tools.js";
import {
  createToolUpdateWorkflowDisplay,
  createWorkflowSnapshot,
  recomputeWorkflowSnapshot,
  renderWorkflowLines,
  type WorkflowSnapshot,
} from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { getDynamicWorkflowSettings } from "./settings.js";
import { parseWorkflowScript, type WorkflowRunResult } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage, type WorkflowStorage } from "./workflow-saved.js";

const WorkflowSnapshotDetailsSchema = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.String()),
  phases: Type.Array(Type.String()),
  currentPhase: Type.Optional(Type.String()),
  logs: Type.Array(Type.String()),
  agents: Type.Array(
    Type.Object({
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
      resultPreview: Type.Optional(Type.String()),
      error: Type.Optional(Type.String()),
      tokens: Type.Optional(Type.Number()),
      model: Type.Optional(Type.String()),
      activity: Type.Optional(Type.String()),
      activityEvents: Type.Optional(
        Type.Array(
          Type.Object({
            kind: Type.Union([
              Type.Literal("thinking"),
              Type.Literal("tool_start"),
              Type.Literal("tool_update"),
              Type.Literal("tool_end"),
              Type.Literal("message"),
              Type.Literal("error"),
            ]),
            label: Type.String(),
            detail: Type.Optional(Type.String()),
            toolName: Type.Optional(Type.String()),
            timestamp: Type.Number(),
            done: Type.Optional(Type.Boolean()),
          }),
        ),
      ),
    }),
  ),
  agentCount: Type.Number(),
  runningCount: Type.Number(),
  doneCount: Type.Number(),
  errorCount: Type.Number(),
  durationMs: Type.Optional(Type.Number()),
  result: Type.Optional(Type.Unknown()),
  tokenUsage: Type.Optional(
    Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      total: Type.Number(),
      cost: Type.Optional(Type.Number()),
    }),
  ),
  runId: Type.Optional(Type.String()),
});

const workflowToolSchema = Type.Object({
  script: Type.Optional(
    Type.String({
      description: [
        "Raw JavaScript workflow script, with no Markdown fences. Mutually exclusive with scriptFile.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }",
        "Use phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), log(message), args, and budget. The workflow must call agent() at least once. Route agents with opts.mode when a specialized mode fits.",
        "parallel() requires functions, not promises: await parallel(items.map(item => () => agent(...))).",
        "For parseable results, give agent() an explicit output contract. Without opts.schema, its final text is returned verbatim. With opts.schema, it must return a schema-valid object.",
      ].join(" "),
    }),
  ),
  scriptFile: Type.Optional(
    Type.String({
      description: [
        "Absolute path to a JavaScript script file to execute exactly as written. Mutually exclusive with script.",
        "First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description', phases: [{ title: 'Phase' }] }",
      ].join(" "),
    }),
  ),
  args: Type.Optional(
    Type.Unknown({
      description: "Optional JSON value exposed to the workflow script as global `args`.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the workflow in the background. Default: true — the tool returns immediately with a run ID, the turn ends so the user isn't blocked, and the result is delivered back into the conversation when it finishes. Set to false only when you need the result inline in this same turn (the call will block until the workflow completes).",
    }),
  ),
  maxAgents: Type.Optional(
    Type.Number({
      description: "Maximum number of agents allowed in this run. Default: 1000.",
    }),
  ),
  agentTimeoutMs: Type.Optional(
    Type.Number({
      description: "Timeout per agent in milliseconds. Default: 1800000 (30 minutes).",
    }),
  ),
  subagentBackend: Type.Optional(
    Type.Union([Type.Literal("lite"), Type.Literal("process")], {
      description:
        "Runtime backend for workflow subagents. Default: process. Use lite for lower-overhead in-process workflow subagents.",
    }),
  ),
});

export type WorkflowToolInput = {
  script?: string;
  scriptFile?: string;
  args?: unknown;
  background?: boolean;
  maxAgents?: number;
  agentTimeoutMs?: number;
  subagentBackend?: "lite" | "process";
};

export interface WorkflowToolOptions {
  cwd?: string;
  pi?: ExtensionAPI;
  concurrency?: number;
  /** Shared manager so background runs are reachable from the `/workflows` command. */
  manager?: WorkflowManager;
  /** Shared saved-workflow storage. */
  storage?: WorkflowStorage;
}

export function createWorkflowTool(
  options: WorkflowToolOptions = {},
): ToolDefinition<typeof workflowToolSchema, unknown, unknown> {
  const storage = options.storage ?? createWorkflowStorage(options.cwd ?? process.cwd());
  const manager =
    options.manager ??
    new WorkflowManager({
      cwd: options.cwd,
      pi: options.pi,
      concurrency: options.concurrency,
      loadSavedWorkflow: (name: string) => storage.load(name)?.script,
    });

  return defineTool({
    name: "workflow",
    label: "Workflow",
    renderShell: "self",
    description: [
      "Execute a deterministic JavaScript workflow that orchestrates multiple subagents with agent(), parallel(), and pipeline().",
      "Provide exactly one of script or scriptFile. script is raw JavaScript; scriptFile is an absolute path to a JS script file. It must start with export const meta = { name, description, phases? } and must call agent() at least once.",
    ].join(" "),
    promptSnippet:
      "Run a deterministic JavaScript workflow. Before use, read dynamic-workflows skill.",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for workflow, fan-out, or multi-agent orchestration.",
      "Before calling workflow, read the dynamic-workflows skill for script format, API, and constraints.",
      "Give each agent() a concrete return contract. Text results are returned verbatim; use opts.schema when the script needs structured data.",
    ],
    parameters: workflowToolSchema,
    prepareArguments(args) {
      return normalizeWorkflowToolArgs(args);
    },
    execute(_toolCallId, params, signal, onUpdate, ctx) {
      manager.setExtensionContext(ctx);
      return executeWorkflowTool(params, signal, onUpdate, manager);
    },
    renderCall(args, theme, context) {
      const rail = formatToolRail(theme, context);
      const name = previewWorkflowName(args.script);
      const status = formatWorkflowStatus(theme, context, "workflow");
      const source = name ?? args.scriptFile;
      return createTextComponent(
        context.lastComponent,
        `${rail}${status}${source === undefined ? "" : ` ${theme.fg("muted", source)}`}`,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const snapshot = parseWorkflowSnapshotDetails(result.details);
      if (snapshot !== undefined) {
        return createTextComponent(
          context.lastComponent,
          renderWorkflowSnapshot(snapshot, expanded, isPartial, theme, context),
        );
      }
      return createTextComponent(
        context.lastComponent,
        renderWorkflowFallbackResult(result, theme, context),
      );
    },
  });
}

function previewWorkflowName(script: string | undefined): string | undefined {
  if (script === undefined || script.trim() === "") return undefined;
  try {
    return parseWorkflowScript(normalizeWorkflowScript(script)).meta.name;
  } catch {
    return undefined;
  }
}

function renderWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
  expanded: boolean,
  isPartial: boolean,
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
  _context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2],
): string {
  const summary = formatWorkflowSnapshotSummary(snapshot);
  const summaryLine = `${theme.fg("dim", "↳ ")}${theme.fg("muted", summary)}`;
  const body = expanded
    ? renderWorkflowLines(snapshot, {
        maxAgents: 12,
        maxLogs: 4,
        showResultPreviews: !isPartial,
      })
        .slice(1)
        .join("\n")
    : renderWorkflowLines(snapshot, { maxAgents: 3, maxLogs: 1, showResultPreviews: false })
        .slice(1)
        .join("\n");
  return body.length === 0 ? summaryLine : `${summaryLine}\n${applyLinePrefix(body, "  ")}`;
}

function formatWorkflowSnapshotSummary(snapshot: WorkflowSnapshot): string {
  const state = `${snapshot.doneCount}/${snapshot.agentCount} done${snapshot.runningCount > 0 ? ` · ${snapshot.runningCount} running` : ""}${snapshot.errorCount > 0 ? ` · ${snapshot.errorCount} errors` : ""}`;
  const phase = snapshot.currentPhase === undefined ? "" : ` · ${snapshot.currentPhase}`;
  const usage =
    snapshot.tokenUsage === undefined ? "" : ` · ${snapshot.tokenUsage.total.toLocaleString()} tok`;
  return `${state}${phase}${usage}`;
}

function formatWorkflowStatus(
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
  context: Pick<Parameters<NonNullable<ToolDefinition["renderCall"]>>[2], "isError" | "isPartial">,
  doneLabel: string,
): string {
  if (context.isError) return theme.bold(theme.fg("error", "workflow failed"));
  if (context.isPartial) return theme.italic(theme.fg("muted", "running workflow"));
  return theme.bold(theme.fg("muted", doneLabel));
}

function renderWorkflowFallbackResult(
  result: AgentToolResult<unknown>,
  theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
  context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2],
): string {
  const rail = formatToolRail(theme, context);
  const text = result.content.find((part) => part.type === "text")?.text ?? "workflow";
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "workflow";
  const verb = context.isError
    ? theme.bold(theme.fg("error", "workflow failed"))
    : theme.bold(theme.fg("muted", "workflow"));
  return `${rail}${verb} ${theme.fg("muted", firstLine)}`;
}

/**
 * The tool result returned when a workflow starts in the background. It both informs the model and
 * tells it to reassure the user: the run continues on its own and the conversation will resume
 * automatically when it finishes, so the user can just wait here (or go do something else).
 *
 * @param {string} name Workflow name.
 * @param {string} runId Workflow run ID.
 * @returns {string} Background-started tool result text.
 */
export function backgroundStartedText(name: string, runId: string): string {
  return [
    `Workflow "${name}" started in the background.`,
    `Run ID: ${runId}`,
    "It keeps running on its own. When it finishes, the result is delivered back",
    "here and the conversation continues automatically — the user does not need to",
    "do anything. Tell the user they can simply wait here for it to finish (it will",
    "resume the conversation by itself), or keep chatting / working on other things",
    "in the meantime; either way the result will come back to this conversation.",
    `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
  ].join("\n");
}

async function executeWorkflowTool(
  params: WorkflowToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  manager: WorkflowManager,
): Promise<AgentToolResult<unknown>> {
  const script = await resolveWorkflowScript(params);
  const parsed = parseWorkflowScript(script);
  const settings = getDynamicWorkflowSettings();

  if (params.background ?? settings.backgroundDefault) {
    const { runId } = manager.startInBackground(script, params.args, {
      maxAgents: params.maxAgents,
      agentTimeoutMs: params.agentTimeoutMs,
      subagentBackend: params.subagentBackend,
    });
    return {
      content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
      details: { runId, background: true },
    };
  }

  let snapshot: WorkflowSnapshot = createWorkflowSnapshot(parsed.meta);
  const display = createToolUpdateWorkflowDisplay(onUpdate, undefined, {
    key: "workflow",
    streamToolUpdates: true,
    maxAgents: 4,
    maxLogs: 1,
    showResultPreviews: false,
  });

  const result = await runWorkflowSync(manager, script, params, signal, display, snapshot);
  snapshot = result.snapshot;
  const runResult = result.runResult;

  if (runResult.agentCount === 0) {
    throw new Error(
      "workflow scripts must call agent() at least once; this workflow declared phases but did not run any subagents",
    );
  }

  snapshot.result = runResult.result;
  snapshot.durationMs = runResult.durationMs;
  snapshot = recomputeWorkflowSnapshot(snapshot);
  display.complete(snapshot);

  const tokenInfo = runResult.tokenUsage
    ? `\n\nToken usage: ${runResult.tokenUsage.total.toLocaleString()} tokens${
        runResult.tokenUsage.cost ? ` ($${runResult.tokenUsage.cost.toFixed(4)})` : ""
      }`
    : "";

  return {
    content: [
      {
        type: "text",
        text: `Workflow ${runResult.meta.name} completed with ${runResult.agentCount} agent(s).\n\nResult:\n${JSON.stringify(runResult.result, null, 2)}${tokenInfo}`,
      },
    ],
    details: {
      ...snapshot,
      phases: runResult.phases,
      logs: runResult.logs,
      result: runResult.result,
      durationMs: runResult.durationMs,
      tokenUsage: runResult.tokenUsage,
      runId: runResult.runId,
    },
  };
}

async function runWorkflowSync(
  manager: WorkflowManager,
  script: string,
  params: WorkflowToolInput,
  signal: AbortSignal | undefined,
  display: ReturnType<typeof createToolUpdateWorkflowDisplay>,
  initialSnapshot: WorkflowSnapshot,
): Promise<{ runResult: WorkflowRunResult; snapshot: WorkflowSnapshot }> {
  let snapshot = initialSnapshot;
  try {
    const runResult = await manager.runSync(script, params.args, {
      maxAgents: params.maxAgents,
      agentTimeoutMs: params.agentTimeoutMs,
      subagentBackend: params.subagentBackend,
      externalSignal: signal,
      onProgress(live) {
        snapshot = recomputeWorkflowSnapshot(live);
        display.update(snapshot);
      },
    });
    return { runResult, snapshot };
  } catch (error) {
    if (
      signal?.aborted === true ||
      (error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED)
    ) {
      for (const agent of snapshot.agents) {
        if (agent.status === "running") {
          agent.status = "skipped";
          agent.error = "aborted";
        }
      }
      snapshot = recomputeWorkflowSnapshot(snapshot);
      display.complete(snapshot);
      throw new Error("Workflow was aborted", { cause: error });
    }
    throw error;
  }
}

function parseWorkflowSnapshotDetails(details: unknown): WorkflowSnapshot | undefined {
  if (!Value.Check(WorkflowSnapshotDetailsSchema, details)) return undefined;
  return Value.Parse(WorkflowSnapshotDetailsSchema, details);
}

function normalizeWorkflowToolArgs(args: unknown): WorkflowToolInput {
  if (args === null || typeof args !== "object")
    throw new Error(
      'workflow requires an object argument. Provide exactly one of: { script: "..." } or { scriptFile: "/absolute/path/to/workflow.js" }.',
    );
  if (!Value.Check(workflowToolSchema, args))
    throw new Error(
      "script source invalid. `script` must be a string, or `scriptFile` must be an absolute path string. Do not provide both.",
    );
  const value = Value.Parse(workflowToolSchema, args);
  const sourceCount = Number(value.script !== undefined) + Number(value.scriptFile !== undefined);
  if (sourceCount !== 1)
    throw new Error(
      "script source ambiguous. Provide exactly one of `script` or `scriptFile`. Use `script` for inline JavaScript, or `scriptFile` for an absolute path to a .js script file.",
    );
  if (value.script !== undefined)
    return { ...value, script: normalizeWorkflowScript(value.script) };
  const scriptFile = value.scriptFile;
  if (scriptFile === undefined || !isAbsolute(scriptFile)) {
    throw new Error(
      `scriptFile must be an absolute path. Received: ${JSON.stringify(scriptFile)}. Use path like /home/coder/project/workflows/audit.workflow.js.`,
    );
  }
  return value;
}

async function resolveWorkflowScript(params: WorkflowToolInput): Promise<string> {
  const sourceCount = Number(params.script !== undefined) + Number(params.scriptFile !== undefined);
  if (sourceCount !== 1) {
    throw new Error(
      "script source ambiguous. Provide exactly one of `script` or `scriptFile`. Use `script` for inline JavaScript, or `scriptFile` for an absolute path to a .js script file.",
    );
  }

  if (params.script !== undefined) return normalizeWorkflowScript(params.script);

  const scriptFile = params.scriptFile;
  if (scriptFile === undefined || !isAbsolute(scriptFile)) {
    throw new Error(
      `scriptFile must be an absolute path. Received: ${JSON.stringify(scriptFile)}. Use path like /home/coder/project/workflows/audit.workflow.js.`,
    );
  }

  try {
    return normalizeWorkflowScript(await readFile(scriptFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read scriptFile at ${scriptFile}: ${errorMessage(error)}. Check file exists, path is absolute, and current process can read it.`,
      { cause: error },
    );
  }
}

function normalizeWorkflowScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

function _isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /\babort(?:ed)?\b/i.test(error.message);
}
