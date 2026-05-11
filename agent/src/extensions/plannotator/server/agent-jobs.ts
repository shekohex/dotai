/**
 * Agent Jobs — Pi (node:http) server handler.
 *
 * Manages background agent processes (spawn, monitor, kill) and exposes HTTP routes + SSE
 * broadcasting for job status updates.
 *
 * Mirrors packages/server/agent-jobs.ts but uses node:http primitives.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  type AgentJobInfo,
  type AgentJobEvent,
  type AgentCapability,
  type AgentCapabilities,
  isTerminalStatus,
  jobSource,
  serializeAgentSSEEvent,
  AGENT_HEARTBEAT_COMMENT,
  AGENT_HEARTBEAT_INTERVAL_MS,
} from "../generated/agent-jobs.js";
import { formatClaudeLogEvent } from "../generated/claude-review.js";
import { json, parseBody } from "./helpers.js";
import { errorMessage } from "../../../utils/error-message.js";

// ---------------------------------------------------------------------------
// Route prefixes
// ---------------------------------------------------------------------------

const BASE = "/api/agents";
const JOBS = `${BASE}/jobs`;
const JOBS_STREAM = `${JOBS}/stream`;
const CAPABILITIES = `${BASE}/capabilities`;

// ---------------------------------------------------------------------------
// which() helper for Node.js
// ---------------------------------------------------------------------------

function whichCmd(cmd: string): boolean {
  try {
    const bin = process.platform === "win32" ? "where" : "which";
    execFileSync(bin, [cmd], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentJobHandlerOptions {
  mode: "plan" | "review" | "annotate";
  getServerUrl: () => string;
  getCwd: () => string;
  /** Server-side command builder for known providers (codex, claude, tour). */
  buildCommand?: (
    provider: string,
    config?: Record<string, unknown>,
  ) => Promise<{
    command: string[];
    outputPath?: string;
    captureStdout?: boolean;
    stdinPrompt?: string;
    cwd?: string;
    prompt?: string;
    label?: string;
    /** Underlying engine used (e.g., "claude" or "codex"). Stored on AgentJobInfo for UI display. */
    engine?: string;
    /** Model used (e.g., "sonnet", "opus"). Stored on AgentJobInfo for UI display. */
    model?: string;
    /** Claude --effort level. */
    effort?: string;
    /** Codex reasoning effort level. */
    reasoningEffort?: string;
    /** Whether Codex fast mode was enabled. */
    fastMode?: boolean;
    /** PR URL at launch time. */
    prUrl?: string;
    /** PR diff scope at launch time. */
    diffScope?: string;
    /** Diff context snapshot at launch (stored on AgentJobInfo for per-job "Copy All"). */
    diffContext?: AgentJobInfo["diffContext"];
  } | null>;
  /** Called when a job completes successfully — parse results and push annotations. */
  onJobComplete?: (
    job: AgentJobInfo,
    meta: { outputPath?: string; stdout?: string; cwd?: string },
  ) => void | Promise<void>;
}

type LaunchBuildResult = {
  command: string[];
  outputPath?: string;
  label: string;
  captureStdout: boolean;
  stdinPrompt?: string;
  spawnCwd?: string;
  promptText?: string;
  jobEngine?: string;
  jobModel?: string;
  jobEffort?: string;
  jobReasoningEffort?: string;
  jobFastMode?: boolean;
  jobPrUrl?: string;
  jobDiffScope?: string;
  jobDiffContext?: AgentJobInfo["diffContext"];
};

type ProcessBuffers = {
  stdoutBuf: string;
  stderrBuf: string;
  logPending: string;
  logFlushTimer: ReturnType<typeof setTimeout> | null;
};

type JobEntry = { info: AgentJobInfo; proc: ChildProcess | null };

type SpawnOptions = {
  captureStdout?: boolean;
  stdinPrompt?: string;
  cwd?: string;
  prompt?: string;
  engine?: string;
  model?: string;
  effort?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  prUrl?: string;
  diffScope?: string;
  diffContext?: AgentJobInfo["diffContext"];
};

type AgentJobContext = {
  options: AgentJobHandlerOptions;
  getServerUrl: () => string;
  getCwd: () => string;
  capabilities: AgentCapability[];
  capabilitiesResponse: AgentCapabilities;
  jobs: Map<string, JobEntry>;
  jobOutputPaths: Map<string, string>;
  subscribers: Set<ServerResponse>;
  getVersion: () => number;
  setVersion: (version: number) => void;
};

function broadcastAgentJobEvent(context: AgentJobContext, event: AgentJobEvent): void {
  context.setVersion(context.getVersion() + 1);
  const data = serializeAgentSSEEvent(event);
  for (const res of context.subscribers) {
    try {
      res.write(data);
    } catch {
      context.subscribers.delete(res);
    }
  }
}

function attachStdoutCapture(
  context: AgentJobContext,
  args: {
    proc: ChildProcess;
    captureStdout: boolean;
    provider: string;
    engine: string | undefined;
    id: string;
    buffers: ProcessBuffers;
  },
): void {
  if (!args.captureStdout || !args.proc.stdout) {
    return;
  }
  args.proc.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    args.buffers.stdoutBuf += text;
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      if (args.provider === "claude" || args.engine === "claude") {
        const formatted = formatClaudeLogEvent(line);
        if (formatted !== null) {
          broadcastAgentJobEvent(context, {
            type: "job:log",
            jobId: args.id,
            delta: formatted + "\n",
          });
        }
        continue;
      }
      try {
        const event: unknown = JSON.parse(line);
        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "result"
        ) {
          continue;
        }
      } catch {}
      broadcastAgentJobEvent(context, { type: "job:log", jobId: args.id, delta: line + "\n" });
    }
  });
}

function attachStderrCapture(
  context: AgentJobContext,
  proc: ChildProcess,
  id: string,
  buffers: ProcessBuffers,
): void {
  if (!proc.stderr) {
    return;
  }
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    buffers.stderrBuf = (buffers.stderrBuf + text).slice(-500);
    buffers.logPending += text;
    buffers.logFlushTimer ??= setTimeout(() => {
      if (buffers.logPending.length > 0) {
        broadcastAgentJobEvent(context, { type: "job:log", jobId: id, delta: buffers.logPending });
        buffers.logPending = "";
      }
      buffers.logFlushTimer = null;
    }, 200);
  });
}

function attachProcessCloseHandler(
  context: AgentJobContext,
  args: {
    proc: ChildProcess;
    id: string;
    captureStdout: boolean;
    buffers: ProcessBuffers;
  },
): void {
  args.proc.on("close", (exitCode) => {
    void (async () => {
      if (args.buffers.logFlushTimer) {
        clearTimeout(args.buffers.logFlushTimer);
        args.buffers.logFlushTimer = null;
      }
      if (args.buffers.logPending.length > 0) {
        broadcastAgentJobEvent(context, {
          type: "job:log",
          jobId: args.id,
          delta: args.buffers.logPending,
        });
        args.buffers.logPending = "";
      }
      const entry = context.jobs.get(args.id);
      if (entry === undefined || isTerminalStatus(entry.info.status)) return;
      entry.info.endedAt = Date.now();
      entry.info.exitCode = exitCode ?? undefined;
      entry.info.status = exitCode === 0 ? "done" : "failed";
      if (exitCode !== 0 && args.buffers.stderrBuf.length > 0) {
        entry.info.error = args.buffers.stderrBuf;
      }
      const jobOutputPath = context.jobOutputPaths.get(args.id);
      const jobCwd = context.jobOutputPaths.get(`${args.id}:cwd`);
      if (exitCode === 0 && context.options.onJobComplete) {
        try {
          await context.options.onJobComplete(entry.info, {
            outputPath: jobOutputPath,
            stdout: args.captureStdout ? args.buffers.stdoutBuf : undefined,
            cwd: jobCwd,
          });
        } catch {}
      }
      context.jobOutputPaths.delete(args.id);
      context.jobOutputPaths.delete(`${args.id}:cwd`);
      broadcastAgentJobEvent(context, { type: "job:completed", job: { ...entry.info } });
    })();
  });
}

function spawnJob(
  context: AgentJobContext,
  provider: string,
  command: string[],
  label: string,
  outputPath?: string,
  spawnOptions?: SpawnOptions,
): AgentJobInfo {
  const id = crypto.randomUUID();
  const source = jobSource(id);
  const info: AgentJobInfo = {
    id,
    source,
    provider,
    label,
    status: "starting",
    startedAt: Date.now(),
    command,
    cwd: context.getCwd(),
    ...(spawnOptions?.engine !== undefined &&
      spawnOptions.engine.length > 0 && { engine: spawnOptions.engine }),
    ...(spawnOptions?.model !== undefined &&
      spawnOptions.model.length > 0 && { model: spawnOptions.model }),
    ...(spawnOptions?.effort !== undefined &&
      spawnOptions.effort.length > 0 && { effort: spawnOptions.effort }),
    ...(spawnOptions?.reasoningEffort !== undefined &&
      spawnOptions.reasoningEffort.length > 0 && { reasoningEffort: spawnOptions.reasoningEffort }),
    ...(spawnOptions?.fastMode === true && { fastMode: spawnOptions.fastMode }),
    ...(spawnOptions?.prUrl !== undefined &&
      spawnOptions.prUrl.length > 0 && { prUrl: spawnOptions.prUrl }),
    ...(spawnOptions?.diffScope !== undefined &&
      spawnOptions.diffScope.length > 0 && { diffScope: spawnOptions.diffScope }),
    ...(spawnOptions?.diffContext !== undefined && { diffContext: spawnOptions.diffContext }),
  };
  let proc: ChildProcess | null = null;
  try {
    const spawnCwd = spawnOptions?.cwd ?? context.getCwd();
    const captureStdout = spawnOptions?.captureStdout ?? false;
    const hasStdinPrompt =
      spawnOptions?.stdinPrompt !== undefined && spawnOptions.stdinPrompt.length > 0;
    proc = spawn(command[0], command.slice(1), {
      cwd: spawnCwd,
      stdio: [hasStdinPrompt ? "pipe" : "ignore", captureStdout ? "pipe" : "ignore", "pipe"],
      env: {
        ...process.env,
        PLANNOTATOR_AGENT_SOURCE: source,
        PLANNOTATOR_API_URL: context.getServerUrl(),
      },
    });
    if (hasStdinPrompt && proc.stdin) {
      proc.stdin.write(spawnOptions.stdinPrompt);
      proc.stdin.end();
    }
    info.status = "running";
    info.cwd = spawnCwd;
    if (spawnOptions?.prompt !== undefined && spawnOptions.prompt.length > 0)
      info.prompt = spawnOptions.prompt;
    context.jobs.set(id, { info, proc });
    if (outputPath !== undefined && outputPath.length > 0)
      context.jobOutputPaths.set(id, outputPath);
    if (spawnOptions?.cwd !== undefined && spawnOptions.cwd.length > 0)
      context.jobOutputPaths.set(`${id}:cwd`, spawnOptions.cwd);
    broadcastAgentJobEvent(context, { type: "job:started", job: { ...info } });
    const buffers: ProcessBuffers = {
      stdoutBuf: "",
      stderrBuf: "",
      logPending: "",
      logFlushTimer: null,
    };
    attachStdoutCapture(context, {
      proc,
      captureStdout,
      provider,
      engine: spawnOptions?.engine,
      id,
      buffers,
    });
    attachStderrCapture(context, proc, id, buffers);
    attachProcessCloseHandler(context, { proc, id, captureStdout, buffers });
    proc.on("error", (err) => {
      const entry = context.jobs.get(id);
      if (entry === undefined || isTerminalStatus(entry.info.status)) return;
      entry.info.status = "failed";
      entry.info.endedAt = Date.now();
      entry.info.error = err.message;
      broadcastAgentJobEvent(context, { type: "job:completed", job: { ...entry.info } });
    });
  } catch (err) {
    context.jobs.set(id, { info, proc: null });
    broadcastAgentJobEvent(context, { type: "job:started", job: { ...info } });
    info.status = "failed";
    info.endedAt = Date.now();
    info.error = errorMessage(err);
    broadcastAgentJobEvent(context, { type: "job:completed", job: { ...info } });
  }
  return { ...info };
}

function killJob(context: AgentJobContext, id: string): boolean {
  const entry = context.jobs.get(id);
  if (entry === undefined || isTerminalStatus(entry.info.status)) return false;
  if (entry.proc) {
    try {
      entry.proc.kill();
    } catch {}
  }
  entry.info.status = "killed";
  entry.info.endedAt = Date.now();
  context.jobOutputPaths.delete(id);
  context.jobOutputPaths.delete(`${id}:cwd`);
  broadcastAgentJobEvent(context, { type: "job:completed", job: { ...entry.info } });
  return true;
}

function killAllJobs(context: AgentJobContext): number {
  let count = 0;
  for (const [id, entry] of context.jobs) {
    if (!isTerminalStatus(entry.info.status)) {
      killJob(context, id);
      count++;
    }
  }
  return count;
}

function getAllJobs(context: AgentJobContext): AgentJobInfo[] {
  return Array.from(context.jobs.values()).map((entry) => ({ ...entry.info }));
}

async function buildLaunchRequest(
  context: AgentJobContext,
  body: Record<string, unknown>,
): Promise<{
  provider: string;
  launch: LaunchBuildResult;
} | null> {
  const provider = typeof body.provider === "string" ? body.provider : "";
  const rawCommand = Array.isArray(body.command) ? body.command : [];
  let command = rawCommand.filter((c: unknown): c is string => typeof c === "string");
  let label = typeof body.label === "string" ? body.label : `${provider} agent`;
  let outputPath: string | undefined;
  const cap = context.capabilities.find((capability) => capability.id === provider);
  if (cap === undefined || !cap.available) {
    return null;
  }
  let captureStdout = false;
  let stdinPrompt: string | undefined;
  let spawnCwd: string | undefined;
  let promptText: string | undefined;
  let jobEngine: string | undefined;
  let jobModel: string | undefined;
  let jobEffort: string | undefined;
  let jobReasoningEffort: string | undefined;
  let jobFastMode: boolean | undefined;
  let jobPrUrl: string | undefined;
  let jobDiffScope: string | undefined;
  let jobDiffContext: AgentJobInfo["diffContext"] | undefined;
  if (context.options.buildCommand) {
    const config: Record<string, unknown> = {};
    if (typeof body.engine === "string") config.engine = body.engine;
    if (typeof body.model === "string") config.model = body.model;
    if (typeof body.reasoningEffort === "string") config.reasoningEffort = body.reasoningEffort;
    if (typeof body.effort === "string") config.effort = body.effort;
    if (body.fastMode === true) config.fastMode = true;
    const built = await context.options.buildCommand(
      provider,
      Object.keys(config).length > 0 ? config : undefined,
    );
    if (built) {
      command = built.command;
      outputPath = built.outputPath;
      captureStdout = built.captureStdout ?? false;
      stdinPrompt = built.stdinPrompt;
      spawnCwd = built.cwd;
      promptText = built.prompt;
      if (built.label !== undefined && built.label.length > 0) label = built.label;
      jobEngine = built.engine;
      jobModel = built.model;
      jobEffort = built.effort;
      jobReasoningEffort = built.reasoningEffort;
      jobFastMode = built.fastMode;
      jobPrUrl = built.prUrl;
      jobDiffScope = built.diffScope;
      jobDiffContext = built.diffContext;
    }
  }
  if (command.length === 0) {
    return { provider, launch: { command: [], label, captureStdout } };
  }
  return {
    provider,
    launch: {
      command,
      outputPath,
      label,
      captureStdout,
      stdinPrompt,
      spawnCwd,
      promptText,
      jobEngine,
      jobModel,
      jobEffort,
      jobReasoningEffort,
      jobFastMode,
      jobPrUrl,
      jobDiffScope,
      jobDiffContext,
    },
  };
}

async function handleLaunch(
  context: AgentJobContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await parseBody(req);
    const built = await buildLaunchRequest(context, body);
    if (built === null) {
      const provider = typeof body.provider === "string" ? body.provider : "";
      json(res, { error: `Unknown or unavailable provider: ${provider}` }, 400);
      return;
    }
    if (built.launch.command.length === 0) {
      json(res, { error: 'Missing "command" array' }, 400);
      return;
    }
    const job = spawnJob(
      context,
      built.provider,
      built.launch.command,
      built.launch.label,
      built.launch.outputPath,
      {
        captureStdout: built.launch.captureStdout,
        stdinPrompt: built.launch.stdinPrompt,
        cwd: built.launch.spawnCwd,
        prompt: built.launch.promptText,
        engine: built.launch.jobEngine,
        model: built.launch.jobModel,
        effort: built.launch.jobEffort,
        reasoningEffort: built.launch.jobReasoningEffort,
        fastMode: built.launch.jobFastMode,
        prUrl: built.launch.jobPrUrl,
        diffScope: built.launch.jobDiffScope,
        diffContext: built.launch.jobDiffContext,
      },
    );
    json(res, { job }, 201);
  } catch {
    json(res, { error: "Invalid JSON" }, 400);
  }
}

async function handleAgentJobsRequest(
  context: AgentJobContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === CAPABILITIES && req.method === "GET") {
    json(res, context.capabilitiesResponse);
    return true;
  }
  if (url.pathname === JOBS_STREAM && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.setTimeout(0);
    const snapshot: AgentJobEvent = { type: "snapshot", jobs: getAllJobs(context) };
    res.write(serializeAgentSSEEvent(snapshot));
    context.subscribers.add(res);
    const heartbeatTimer = setInterval(() => {
      try {
        res.write(AGENT_HEARTBEAT_COMMENT);
      } catch {
        clearInterval(heartbeatTimer);
        context.subscribers.delete(res);
      }
    }, AGENT_HEARTBEAT_INTERVAL_MS);
    res.on("close", () => {
      clearInterval(heartbeatTimer);
      context.subscribers.delete(res);
    });
    return true;
  }
  if (url.pathname === JOBS && req.method === "GET") {
    const since = url.searchParams.get("since");
    if (since !== null) {
      const sinceVersion = parseInt(since, 10);
      if (!Number.isNaN(sinceVersion) && sinceVersion === context.getVersion()) {
        res.writeHead(304);
        res.end();
        return true;
      }
    }
    json(res, { jobs: getAllJobs(context), version: context.getVersion() });
    return true;
  }
  if (url.pathname === JOBS && req.method === "POST") {
    await handleLaunch(context, req, res);
    return true;
  }
  if (
    url.pathname.startsWith(JOBS + "/") &&
    url.pathname !== JOBS_STREAM &&
    req.method === "DELETE"
  ) {
    const id = url.pathname.slice(JOBS.length + 1);
    if (id.length === 0) {
      json(res, { error: "Missing job ID" }, 400);
      return true;
    }
    const found = killJob(context, id);
    if (!found) {
      json(res, { error: "Job not found or already terminal" }, 404);
      return true;
    }
    json(res, { ok: true });
    return true;
  }
  if (url.pathname === JOBS && req.method === "DELETE") {
    const count = killAllJobs(context);
    json(res, { ok: true, killed: count });
    return true;
  }
  return false;
}

export function createAgentJobHandler(options: AgentJobHandlerOptions) {
  const { mode, getServerUrl, getCwd } = options;

  const jobs = new Map<string, JobEntry>();
  const jobOutputPaths = new Map<string, string>();
  const subscribers = new Set<ServerResponse>();
  let version = 0;
  const capabilities: AgentCapability[] = [
    { id: "claude", name: "Claude Code", available: whichCmd("claude") },
    { id: "codex", name: "Codex CLI", available: whichCmd("codex") },
    { id: "tour", name: "Code Tour", available: whichCmd("claude") || whichCmd("codex") },
  ];
  const capabilitiesResponse: AgentCapabilities = {
    mode,
    providers: capabilities,
    available: capabilities.some((c) => c.available),
  };
  const context: AgentJobContext = {
    options,
    getServerUrl,
    getCwd,
    capabilities,
    capabilitiesResponse,
    jobs,
    jobOutputPaths,
    subscribers,
    getVersion: () => version,
    setVersion: (nextVersion) => {
      version = nextVersion;
    },
  };

  return {
    killAll: () => killAllJobs(context),

    handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      return handleAgentJobsRequest(context, req, res, url);
    },
  };
}
