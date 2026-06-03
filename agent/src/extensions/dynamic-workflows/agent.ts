import {
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { accessSync } from "node:fs";
import type { Static, TSchema } from "typebox";
import { createSubagentSDK } from "../../subagent-sdk/sdk.js";
import type { SubagentChildIpcEvent } from "../../subagent-sdk/ipc.js";
import type { SubagentHandle, SubagentSDK } from "../../subagent-sdk/sdk-types.js";
import type { RuntimeSubagent } from "../../subagent-sdk/types.js";
import type { WorkflowAgentActivityEvent } from "./display.js";
import { getDynamicWorkflowSettings } from "./settings.js";

export interface WorkflowAgentOptions {
  cwd?: string;
  pi?: ExtensionAPI;
  ctx?: ExtensionContext;
  mode?: string;
  outputRetryCount?: number;
  toolNames?: string[];
  customTools?: ToolDefinition[];
  instructions?: string;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  toolNames?: string[];
  customTools?: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  onStart?: (state: RuntimeSubagent) => void;
  onUsage?: (usage: AgentUsage) => void;
  onActivity?: (event: WorkflowAgentActivityEvent) => void;
  mode?: string;
  outputRetryCount?: number;
  cwd?: string;
  resumeSession?: { sessionId: string; sessionPath: string };
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class WorkflowAgent {
  private readonly cwd: string;
  private readonly pi: ExtensionAPI | undefined;
  private readonly ctx: ExtensionContext | undefined;
  private readonly mode: string | undefined;
  private readonly outputRetryCount: number | undefined;
  private readonly toolNames: string[];
  private readonly customTools: ToolDefinition[];
  private readonly instructions?: string;

  constructor(options: WorkflowAgentOptions = {}) {
    const settings = getDynamicWorkflowSettings();
    this.cwd = options.cwd ?? process.cwd();
    this.pi = options.pi;
    this.ctx = options.ctx;
    this.mode = options.mode ?? settings.mode;
    this.outputRetryCount = options.outputRetryCount ?? settings.outputRetryCount;
    this.toolNames = options.toolNames ?? settings.toolNames;
    this.customTools = options.customTools ?? [];
    this.instructions = options.instructions;
  }

  async run<TSchemaDef extends TSchema>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> & { schema: TSchemaDef },
  ): Promise<Static<TSchemaDef>>;
  async run(prompt: string, options?: AgentRunOptions): Promise<string>;
  async run(prompt: string, options: AgentRunOptions<TSchema | undefined> = {}): Promise<unknown> {
    if (this.pi === undefined || this.ctx === undefined) {
      throw new Error("WorkflowAgent requires pi and ctx when no custom agent runner is injected");
    }

    const runCwd = options.cwd ?? this.cwd;
    const customTools = [...this.customTools, ...(options.customTools ?? [])];
    const toolNames = Array.from(new Set([...this.toolNames, ...(options.toolNames ?? [])]));
    const sdk = createSubagentSDK(this.pi, { backend: { kind: "lite" } });

    try {
      if (isSignalAborted(options.signal)) throw new Error("Subagent was aborted");
      const baseParams = {
        name: options.label ?? "workflow agent",
        task: this.buildPrompt(prompt, options, options.schema !== undefined),
        mode: options.mode ?? this.mode,
        cwd: runCwd,
        autoExit: true,
        persisted: true,
        completion: false as const,
        ...(toolNames.length === 0 ? {} : { toolNames }),
        ...(customTools.length === 0 ? {} : { customTools }),
      };
      const started =
        options.schema === undefined
          ? await startOrResumeTextSubagent(sdk, this.ctx, baseParams, options)
          : await startOrResumeStructuredSubagent(
              sdk,
              this.ctx,
              baseParams,
              options,
              options.schema,
              options.outputRetryCount ?? this.outputRetryCount,
            );
      const unsubscribeActivity = subscribeWorkflowAgentActivity(
        sdk,
        started.handle.sessionId,
        options.onActivity,
      );
      options.onStart?.(started.handle.getState());
      try {
        const terminal = await started.handle.waitForCompletion({ signal: options.signal });
        emitUsage(options, terminal);
        return readTerminalResult(terminal, options.schema !== undefined);
      } finally {
        unsubscribeActivity();
      }
    } finally {
      sdk.dispose();
    }
  }

  private buildPrompt(
    prompt: string,
    options: AgentRunOptions<TSchema | undefined>,
    structured: boolean,
  ): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label !== undefined && options.label !== ""
        ? `Task label: ${options.label}`
        : undefined,
      prompt,
    ].filter((part): part is string => part !== undefined && part !== "");

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a StructuredOutput tool call.",
          "- The StructuredOutput arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of StructuredOutput.",
          "- If you need to inspect files or run commands first, do so, then call StructuredOutput exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }
}

type WorkflowSubagentParams = {
  name: string;
  task: string;
  mode?: string;
  cwd: string;
  autoExit: boolean;
  persisted: boolean;
  completion: false;
  toolNames?: string[];
  customTools?: ToolDefinition[];
};

async function startOrResumeTextSubagent(
  sdk: SubagentSDK,
  ctx: ExtensionContext,
  baseParams: WorkflowSubagentParams,
  options: AgentRunOptions<TSchema | undefined>,
): Promise<{ handle: SubagentHandle }> {
  const params = { ...baseParams, outputFormat: { type: "text" as const } };
  if (options.resumeSession === undefined || !canAccessResumeSession(options.resumeSession)) {
    return sdk.start(params, ctx, undefined, options.signal);
  }
  try {
    return await sdk.resume(
      {
        ...params,
        sessionId: options.resumeSession.sessionId,
        sessionPath: options.resumeSession.sessionPath,
      },
      ctx,
      undefined,
      options.signal,
    );
  } catch (error) {
    if (!isInaccessibleResumeSessionError(error)) throw error;
    return sdk.start(params, ctx, undefined, options.signal);
  }
}

async function startOrResumeStructuredSubagent(
  sdk: SubagentSDK,
  ctx: ExtensionContext,
  baseParams: WorkflowSubagentParams,
  options: AgentRunOptions<TSchema | undefined>,
  schema: TSchema,
  retryCount: number | undefined,
): Promise<{ handle: SubagentHandle }> {
  const params = {
    ...baseParams,
    outputFormat: {
      type: "json_schema" as const,
      schema,
      retryCount,
    },
  };
  if (options.resumeSession === undefined || !canAccessResumeSession(options.resumeSession)) {
    return sdk.start(params, ctx, undefined, options.signal);
  }
  try {
    return await sdk.resume(
      {
        ...params,
        sessionId: options.resumeSession.sessionId,
        sessionPath: options.resumeSession.sessionPath,
      },
      ctx,
      undefined,
      options.signal,
    );
  } catch (error) {
    if (!isInaccessibleResumeSessionError(error)) throw error;
    return sdk.start(params, ctx, undefined, options.signal);
  }
}

function canAccessResumeSession(resumeSession: { sessionPath: string }): boolean {
  try {
    accessSync(resumeSession.sessionPath);
    return true;
  } catch {
    return false;
  }
}

function isInaccessibleResumeSessionError(error: unknown): boolean {
  return error instanceof Error && /sessionPath is not accessible/u.test(error.message);
}

function subscribeWorkflowAgentActivity(
  sdk: SubagentSDK,
  sessionId: string,
  onActivity: ((event: WorkflowAgentActivityEvent) => void) | undefined,
): () => void {
  if (onActivity === undefined) return () => {};
  const events = [
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "turn_start",
  ] as const;
  const unsubscribers = events.map((eventType) =>
    sdk.onChildEvent(sessionId, eventType, (event) => {
      const activity = createActivityEvent(event);
      if (activity !== undefined) onActivity(activity);
    }),
  );
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

function createActivityEvent(event: SubagentChildIpcEvent): WorkflowAgentActivityEvent | undefined {
  if (event.type === "turn_start") {
    return { kind: "thinking", label: "thinking", timestamp: Date.now(), done: false };
  }
  if (event.type === "tool_execution_start") {
    const toolName = readStringField(event, "toolName") ?? "tool";
    return {
      kind: "tool_start",
      label: summarizeToolActivity(toolName, readUnknownField(event, "args")),
      detail: summarizeToolDetail(toolName, readUnknownField(event, "args")),
      toolName,
      timestamp: Date.now(),
      done: false,
    };
  }
  if (event.type === "tool_execution_update") {
    return undefined;
  }
  if (event.type === "tool_execution_end") {
    const toolName = readStringField(event, "toolName") ?? "tool";
    return {
      kind: "tool_end",
      label: toolName,
      toolName,
      timestamp: Date.now(),
      done: true,
    };
  }
  return undefined;
}

function summarizeToolActivity(toolName: string, args: unknown): string {
  const summary = summarizeKnownTool(toolName, args);
  return summary?.label ?? `using ${toolName} ...`;
}

function summarizeToolDetail(toolName: string, args: unknown): string | undefined {
  return summarizeKnownTool(toolName, args)?.detail ?? toolName;
}

function summarizeKnownTool(
  toolName: string,
  args: unknown,
): { label: string; detail?: string } | undefined {
  switch (toolName) {
    case "read":
      return summarizeReadTool(args);
    case "bash":
      return summarizeBashTool(args);
    case "edit":
      return summarizeEditTool(args);
    case "write":
      return summarizeWriteTool(args);
    case "apply_patch":
      return summarizeApplyPatchTool(args);
    case "webfetch":
      return summarizeWebFetchTool(args);
    case "websearch":
      return summarizeWebSearchTool(args);
    case "subagent":
      return summarizeSubagentTool(args);
    case "workflow":
      return summarizeWorkflowTool(args);
    case "execute":
      return summarizeExecuteTool(args);
    case "resume":
      return summarizeResumeTool(args);
    case "notify":
      return summarizeNotifyTool(args);
    case "goal":
      return summarizeGoalTool(args);
    case "context_tree_query":
      return summarizeContextTreeQueryTool(args);
    case "generate_image":
      return summarizeGenerateImageTool(args);
    default:
      return undefined;
  }
}

function summarizeReadTool(args: unknown): { label: string; detail?: string } | undefined {
  const path = readStringField(args, "path");
  if (path === undefined) return undefined;
  const offset = readNumberField(args, "offset");
  const limit = readNumberField(args, "limit");
  const range =
    offset === undefined ? "" : `line ${offset}${limit === undefined ? "" : ` · ${limit} lines`}`;
  return { label: `read ${formatPathForActivity(path)}`, detail: range || undefined };
}

function summarizeBashTool(args: unknown): { label: string; detail?: string } | undefined {
  const command = readStringField(args, "command");
  if (command === undefined) return undefined;
  const description = readStringField(args, "description");
  return { label: description ?? "run shell command" };
}

function summarizeEditTool(args: unknown): { label: string; detail?: string } | undefined {
  const path = readStringField(args, "path");
  if (path === undefined) return undefined;
  const edits = readArrayField(args, "edits");
  const count =
    edits === undefined ? "edits" : `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
  return { label: `edit ${formatPathForActivity(path)}`, detail: count };
}

function summarizeWriteTool(args: unknown): { label: string; detail?: string } | undefined {
  const path = readStringField(args, "path");
  if (path === undefined) return undefined;
  const content = readStringField(args, "content");
  const chars = content === undefined ? undefined : `${content.length.toLocaleString()} chars`;
  return { label: `write ${formatPathForActivity(path)}`, detail: chars };
}

function summarizeApplyPatchTool(args: unknown): { label: string; detail?: string } | undefined {
  const patchText = readStringField(args, "patchText");
  if (patchText === undefined) return { label: "applying patch" };
  const files = extractPatchFileNames(patchText);
  const target =
    files.length === 0
      ? "patch"
      : files
          .slice(0, 2)
          .map((file) => formatPathForActivity(file))
          .join(", ");
  return {
    label: `patch ${shortenActivity(target)}`,
    detail: `${files.length} file${files.length === 1 ? "" : "s"}`,
  };
}

function summarizeWebFetchTool(args: unknown): { label: string; detail?: string } | undefined {
  const url = readStringField(args, "url");
  if (url === undefined) return undefined;
  return { label: `fetching ${shortenActivity(url)}`, detail: url };
}

function summarizeWebSearchTool(args: unknown): { label: string; detail?: string } | undefined {
  const query = readStringField(args, "query");
  if (query === undefined) return undefined;
  return { label: `searching web ${shortenActivity(query)}`, detail: query };
}

function summarizeSubagentTool(args: unknown): { label: string; detail?: string } | undefined {
  const action = readStringField(args, "action");
  if (action === "start") {
    const name = readStringField(args, "name") ?? "subagent";
    const mode = readStringField(args, "mode");
    return { label: `starting subagent ${shortenActivity(name)}`, detail: mode };
  }
  if (action === "message") {
    return { label: "messaging subagent", detail: readStringField(args, "sessionId") };
  }
  if (action === "cancel") {
    return { label: "cancelling subagent", detail: readStringField(args, "sessionId") };
  }
  if (action === "list") return { label: "listing subagents" };
  return undefined;
}

function summarizeWorkflowTool(args: unknown): { label: string; detail?: string } | undefined {
  const script = readStringField(args, "script");
  if (script === undefined) return { label: "running workflow" };
  const name = extractWorkflowName(script);
  return { label: `running workflow ${shortenActivity(name ?? "script")}`, detail: name };
}

function summarizeExecuteTool(args: unknown): { label: string; detail?: string } | undefined {
  const code = readStringField(args, "code");
  if (code === undefined) return undefined;
  return { label: "executing sandbox code", detail: shortenActivity(code, 120) };
}

function summarizeResumeTool(args: unknown): { label: string; detail?: string } | undefined {
  const executionId = readStringField(args, "executionId");
  const action = readStringField(args, "action");
  if (executionId === undefined) return undefined;
  return { label: `resuming ${shortenActivity(executionId)}`, detail: action };
}

function summarizeNotifyTool(args: unknown): { label: string; detail?: string } | undefined {
  const title = readStringField(args, "title");
  const message = readStringField(args, "message");
  const summary = title ?? message;
  if (summary === undefined) return { label: "sending notification" };
  return { label: `notifying ${shortenActivity(summary)}`, detail: message };
}

function summarizeGoalTool(args: unknown): { label: string; detail?: string } | undefined {
  const action = readStringField(args, "action");
  if (action === undefined) return undefined;
  return { label: `${action} goal`, detail: readStringField(args, "reason") };
}

function summarizeContextTreeQueryTool(
  args: unknown,
): { label: string; detail?: string } | undefined {
  const ids = readArrayField(args, "toolCallIds");
  if (ids === undefined) return undefined;
  return {
    label: `querying ${ids.length} tool result${ids.length === 1 ? "" : "s"}`,
    detail: ids.map(String).join(", "),
  };
}

function summarizeGenerateImageTool(args: unknown): { label: string; detail?: string } | undefined {
  const prompt = readStringField(args, "prompt");
  if (prompt === undefined) return { label: "generating image" };
  return { label: `generating image ${shortenActivity(prompt)}`, detail: prompt };
}

function readStringField(value: unknown, field: string): string | undefined {
  const fieldValue = readUnknownField(value, field);
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function readNumberField(value: unknown, field: string): number | undefined {
  const fieldValue = readUnknownField(value, field);
  return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : undefined;
}

function readArrayField(value: unknown, field: string): unknown[] | undefined {
  const fieldValue = readUnknownField(value, field);
  return Array.isArray(fieldValue) ? fieldValue : undefined;
}

function readUnknownField(value: unknown, field: string): unknown {
  if (!isUnknownRecord(value)) return undefined;
  return value[field];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractPatchFileNames(patchText: string): string[] {
  return patchText.split("\n").flatMap((line) => {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim());
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

function formatPathForActivity(path: string): string {
  const shortenedPath = shortenPathForActivity(path);
  const lastSlashIndex = shortenedPath.lastIndexOf("/");
  if (lastSlashIndex === -1) return shortenedPath;
  const basename = shortenedPath.slice(lastSlashIndex + 1) || shortenedPath;
  const dirname = shortenedPath.slice(0, lastSlashIndex);
  if (dirname === "" || dirname === ".") return `${basename} ./`;
  return `${basename} ${dirname}/`;
}

function shortenPathForActivity(path: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedCwd = process.cwd().replaceAll("\\", "/");
  if (normalizedPath === normalizedCwd) return ".";
  if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
    const relativePath = normalizedPath.slice(normalizedCwd.length + 1);
    return relativePath === "" ? "." : `./${relativePath}`;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home !== undefined && home !== "" && normalizedPath.startsWith(home.replaceAll("\\", "/"))) {
    return `~${normalizedPath.slice(home.length)}`;
  }
  return normalizedPath;
}

function extractWorkflowName(script: string): string | undefined {
  return /name\s*:\s*['"]([^'"]+)['"]/.exec(script)?.[1];
}

function shortenActivity(value: string, max = 72): string {
  const text = value.replaceAll(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function emitUsage(options: AgentRunOptions<TSchema | undefined>, terminal: RuntimeSubagent): void {
  if (options.onUsage === undefined || terminal.tokenUsage === undefined) return;
  options.onUsage(terminal.tokenUsage);
}

function readTerminalResult(terminal: RuntimeSubagent, structured: boolean): unknown {
  if (structured) {
    if (terminal.status !== "completed" || terminal.structured === undefined) {
      throw new Error(
        terminal.structuredError?.message ?? "Subagent finished without structured output",
      );
    }
    return terminal.structured;
  }
  if (terminal.status !== "completed") {
    throw new Error(terminal.summary ?? `Subagent failed with status ${terminal.status}`);
  }
  return terminal.summary ?? "";
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
