import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AgentJobInfo,
  AgentCapabilities,
  AgentCapability,
  AgentJobEvent,
} from "../generated/agent-jobs.js";
import {
  AGENT_HEARTBEAT_COMMENT,
  AGENT_HEARTBEAT_INTERVAL_MS,
  isTerminalStatus,
  serializeAgentSSEEvent,
} from "../generated/agent-jobs.js";
import type { DiffType } from "../generated/review-core.js";
import type { PRDiffScope } from "../generated/pr-stack.js";
import type { PRMetadata } from "../generated/pr-provider.js";
import { getCurrentPiSessionContext } from "../current-pi-session.js";
import { json, parseBody } from "./helpers.js";
import {
  launchReviewModeSubagent,
  startReviewModeSubagent,
  ReviewStructuredResultSchema,
  type ReviewStructuredResult,
} from "./review-mode-launch.js";
import type { RuntimeSubagent } from "../../../subagent-sdk/types.js";
import type { SubagentHandle, SubagentSDK } from "../../../subagent-sdk/sdk-types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { errorMessage } from "../../../utils/error-message.js";
import type { EditorAnnotationInput } from "./annotations.js";

type ReviewAgentJobArgs = {
  canLaunchReviewAgent: () => boolean;
  resolveAgentCwd: () => string;
  getCurrentPatch: () => string;
  getCurrentDiffType: () => DiffType;
  getCurrentBase: () => string;
  getCurrentPrDiffScope: () => PRDiffScope;
  getPrMeta: () => PRMetadata | undefined;
  addAnnotations: (annotations: EditorAnnotationInput[]) => void;
};

type JobRecord = {
  info: AgentJobInfo;
  sessionId?: string;
  sdk?: SubagentSDK;
  restoreCtx?: ExtensionContext;
  logContent?: string;
};

const BASE = "/api/agents";
const JOBS = `${BASE}/jobs`;
const JOBS_STREAM = `${JOBS}/stream`;
const CAPABILITIES = `${BASE}/capabilities`;

function mapSubagentStatus(status: RuntimeSubagent["status"]): AgentJobInfo["status"] {
  if (status === "completed") {
    return "done";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "killed";
  }
  return "running";
}

function getAllJobs(jobs: Map<string, JobRecord>): AgentJobInfo[] {
  return Array.from(jobs.values()).map((entry) => ({ ...entry.info }));
}

function broadcast(
  subscribers: Set<ServerResponse>,
  event: AgentJobEvent,
  version: { value: number },
): void {
  version.value += 1;
  const payload = serializeAgentSSEEvent(event);
  for (const res of subscribers) {
    try {
      res.write(payload);
    } catch {
      subscribers.delete(res);
    }
  }
}

function syncJobInfoFromState(info: AgentJobInfo, state: RuntimeSubagent): void {
  info.status = mapSubagentStatus(state.status);
  if (state.completedAt !== undefined) {
    info.endedAt = state.completedAt;
  }
  if (state.exitCode !== undefined) {
    info.exitCode = state.exitCode;
  }
  if (state.status === "failed" && state.summary !== undefined && state.summary.length > 0) {
    info.error = state.summary;
  }
}

function getLogDelta(previousContent: string, nextContent: string): string {
  if (nextContent.startsWith(previousContent)) {
    return nextContent.slice(previousContent.length);
  }
  return nextContent;
}

async function syncJobLog(
  entry: JobRecord,
  subscribers: Set<ServerResponse>,
  version: { value: number },
): Promise<void> {
  if (entry.sdk === undefined || entry.sessionId === undefined) {
    return;
  }
  try {
    const capture = await entry.sdk.captureOutput({ sessionId: entry.sessionId, lines: 2000 });
    const nextContent = capture.text;
    const previousContent = entry.logContent ?? "";
    if (nextContent === previousContent) {
      return;
    }
    entry.logContent = nextContent;
    const delta = getLogDelta(previousContent, nextContent);
    if (delta.length === 0) {
      return;
    }
    broadcast(subscribers, { type: "job:log", jobId: entry.info.id, delta }, version);
  } catch {}
}

function getStructuredResult(value: unknown): ReviewStructuredResult | undefined {
  if (!Value.Check(ReviewStructuredResultSchema, value)) {
    return undefined;
  }
  return value;
}

async function syncJobsFromSdkState(
  jobs: Map<string, JobRecord>,
  subscribers: Set<ServerResponse>,
  version: { value: number },
): Promise<void> {
  for (const entry of jobs.values()) {
    if (entry.sdk === undefined || entry.restoreCtx === undefined) {
      continue;
    }
    try {
      await entry.sdk.restore(entry.restoreCtx);
      if (entry.sessionId === undefined) {
        continue;
      }
      const state = entry.sdk.list().find((candidate) => candidate.sessionId === entry.sessionId);
      if (state !== undefined) {
        syncJobInfoFromState(entry.info, state);
      }
      await syncJobLog(entry, subscribers, version);
    } catch {}
  }
}

function createCapabilities(): AgentCapabilities {
  const providers: AgentCapability[] = [{ id: "review", name: "Review Mode", available: true }];
  return { mode: "review", providers, available: true };
}

function createJobInfo(cwd: string): AgentJobInfo {
  const id = crypto.randomUUID();
  return {
    id,
    source: `agent-${id.slice(0, 8)}`,
    provider: "review",
    label: "Code Review",
    status: "starting",
    startedAt: Date.now(),
    command: ["subagent", "mode=review"],
    cwd,
  };
}

function getPatchFilePaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (match === null) {
      continue;
    }
    paths.add(match[2]);
  }
  return Array.from(paths);
}

function normalizeFindingFilePath(filePath: string, diffFilePaths: string[]): string {
  if (diffFilePaths.includes(filePath)) {
    return filePath;
  }

  const suffixMatches = diffFilePaths.filter(
    (candidate) => candidate === filePath || candidate.endsWith(`/${filePath}`),
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }

  const basename = filePath.split("/").at(-1);
  if (basename === undefined) {
    return filePath;
  }
  const basenameMatches = diffFilePaths.filter((candidate) => candidate.endsWith(`/${basename}`));
  if (basenameMatches.length === 1) {
    return basenameMatches[0];
  }

  return filePath;
}

export function toAnnotations(
  source: string,
  currentPatch: string,
  result: Awaited<ReturnType<typeof launchReviewModeSubagent>>["structured"],
) {
  const diffFilePaths = getPatchFilePaths(currentPatch);
  return result.findings.map((finding) => {
    const tagParts = ["AI Review"];
    if (finding.kind !== undefined) {
      tagParts.push(finding.kind.toUpperCase());
    }
    if (finding.severity !== undefined && finding.severity !== finding.kind) {
      tagParts.push(finding.severity.toUpperCase());
    }
    const bodyParts = [
      `[${tagParts.join(" · ")}] ${finding.title}`,
      finding.text,
      ...(finding.reasoning === undefined || finding.reasoning.length === 0
        ? []
        : [`Why: ${finding.reasoning}`]),
    ];
    const annotation = {
      source,
      filePath: normalizeFindingFilePath(finding.filePath, diffFilePaths),
      selectedText: finding.title,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      ...(finding.side === undefined ? {} : { side: finding.side }),
      comment: bodyParts.join("\n\n"),
      author: "AI",
      title: finding.title,
      kind: finding.kind,
    };
    return {
      ...annotation,
      ...(finding.severity === undefined ? {} : { severity: finding.severity }),
      ...(finding.reasoning === undefined ? {} : { reasoning: finding.reasoning }),
    };
  });
}

async function finalizeReviewJob(
  args: ReviewAgentJobArgs,
  entry: JobRecord,
  handle: SubagentHandle,
  subscribers: Set<ServerResponse>,
  version: { value: number },
): Promise<void> {
  try {
    const terminal = await handle.waitForCompletion();
    if (isTerminalStatus(entry.info.status)) {
      return;
    }
    syncJobInfoFromState(entry.info, terminal);
    if (terminal.status === "completed" && terminal.structured !== undefined) {
      const structured = getStructuredResult(terminal.structured);
      if (structured === undefined) {
        entry.info.status = "failed";
        entry.info.error = "Review completed without valid structured output.";
        return;
      }
      entry.info.summary = {
        correctness: structured.correctness,
        explanation: structured.explanation,
        confidence: structured.confidence,
      };
      args.addAnnotations(toAnnotations(entry.info.source, args.getCurrentPatch(), structured));
    } else if (terminal.summary !== undefined && terminal.summary.length > 0) {
      entry.info.error = terminal.summary;
    }
  } catch (error) {
    if (!isTerminalStatus(entry.info.status)) {
      entry.info.status = "failed";
      entry.info.endedAt = Date.now();
      entry.info.error = errorMessage(error);
    }
  } finally {
    await syncJobLog(entry, subscribers, version);
    entry.sdk?.dispose();
    entry.sdk = undefined;
  }
}

async function startReviewJob(
  args: ReviewAgentJobArgs,
  jobs: Map<string, JobRecord>,
  subscribers: Set<ServerResponse>,
  version: { value: number },
): Promise<AgentJobInfo> {
  const currentSession = getCurrentPiSessionContext();
  if (currentSession === undefined) {
    throw new Error("No active Pi session available for review mode launch.");
  }
  if (!args.canLaunchReviewAgent()) {
    throw new Error(
      "AI review agent requires local checkout access for this review session. Reopen review with local access enabled.",
    );
  }
  const cwd = args.resolveAgentCwd();
  const info = createJobInfo(cwd);
  const entry: JobRecord = { info, restoreCtx: currentSession.ctx };
  jobs.set(info.id, entry);
  broadcast(subscribers, { type: "job:started", job: { ...info } }, version);
  let started;
  try {
    started = await startReviewModeSubagent({
      pi: currentSession.pi,
      ctx: currentSession.ctx,
      cwd,
      currentPatch: args.getCurrentPatch(),
      currentDiffType: args.getCurrentDiffType(),
      currentBase: args.getCurrentBase(),
      currentPrDiffScope: args.getCurrentPrDiffScope(),
      prMetadata: args.getPrMeta(),
    });
  } catch (error) {
    entry.info.status = "failed";
    entry.info.endedAt = Date.now();
    entry.info.error = errorMessage(error);
    broadcast(subscribers, { type: "job:completed", job: { ...entry.info } }, version);
    throw error;
  }
  entry.sdk = started.sdk;
  entry.sessionId = started.state.sessionId;
  info.prompt = started.prompt;
  syncJobInfoFromState(info, started.state);
  broadcast(subscribers, { type: "job:updated", job: { ...info } }, version);
  void finalizeReviewJob(args, entry, started.handle, subscribers, version).then(() => {
    broadcast(subscribers, { type: "job:completed", job: { ...entry.info } }, version);
  });
  return { ...info };
}

function createJobsStreamHandler(args: {
  jobs: Map<string, JobRecord>;
  subscribers: Set<ServerResponse>;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(
      serializeAgentSSEEvent({
        type: "snapshot",
        jobs: getAllJobs(args.jobs),
      }),
    );
    for (const [jobId, entry] of args.jobs) {
      if (entry.logContent === undefined || entry.logContent.length === 0) {
        continue;
      }
      res.write(serializeAgentSSEEvent({ type: "job:log", jobId, delta: entry.logContent }));
    }
    args.subscribers.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(AGENT_HEARTBEAT_COMMENT);
      } catch {
        args.subscribers.delete(res);
        clearInterval(heartbeat);
      }
    }, AGENT_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    req.on("close", () => {
      args.subscribers.delete(res);
      clearInterval(heartbeat);
    });
  };
}

function createAgentJobsHandler(args: {
  reviewArgs: ReviewAgentJobArgs;
  jobs: Map<string, JobRecord>;
  capabilities: AgentCapabilities;
  subscribers: Set<ServerResponse>;
  version: { value: number };
  killJob: (id: string) => Promise<boolean>;
  killAll: () => Promise<number>;
}): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const streamHandler = createJobsStreamHandler({
    jobs: args.jobs,
    subscribers: args.subscribers,
  });

  return async (req, res, url) => {
    if (url.pathname === CAPABILITIES && req.method === "GET") {
      json(res, args.capabilities);
      return true;
    }
    if (url.pathname === JOBS && req.method === "GET") {
      json(res, {
        jobs: getAllJobs(args.jobs),
        version: args.version.value,
      });
      return true;
    }
    if (url.pathname === JOBS_STREAM && req.method === "GET") {
      streamHandler(req, res);
      return true;
    }
    if (url.pathname === JOBS && req.method === "POST") {
      const body = await parseBody(req);
      const provider = typeof body.provider === "string" ? body.provider : "review";
      if (provider === "review") {
        try {
          const job = await startReviewJob(
            args.reviewArgs,
            args.jobs,
            args.subscribers,
            args.version,
          );
          json(res, { job }, 201);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to launch review mode";
          json(res, { error: message }, 500);
        }
        return true;
      }
      if (provider.length > 0) {
        json(res, { error: `Unknown or unavailable provider: ${provider}` }, 400);
        return true;
      }
      json(res, { error: "Unknown or unavailable provider" }, 400);
      return true;
    }
    if (
      url.pathname.startsWith(`${JOBS}/`) &&
      url.pathname !== JOBS_STREAM &&
      req.method === "DELETE"
    ) {
      const id = url.pathname.slice(JOBS.length + 1);
      if (id.length === 0) {
        json(res, { error: "Missing job ID" }, 400);
        return true;
      }
      const found = await args.killJob(id);
      if (!found) {
        json(res, { error: "Job not found or already terminal" }, 404);
        return true;
      }
      json(res, { ok: true });
      return true;
    }
    if (url.pathname === JOBS && req.method === "DELETE") {
      const killed = await args.killAll();
      if (killed > 0) {
        broadcast(args.subscribers, { type: "jobs:cleared" }, args.version);
      }
      json(res, { ok: true, killed });
      return true;
    }
    return false;
  };
}

export function createReviewAgentJobs(args: ReviewAgentJobArgs) {
  const jobs = new Map<string, JobRecord>();
  const capabilities = createCapabilities();
  const subscribers = new Set<ServerResponse>();
  const version = { value: 0 };

  const restoreTimer = setInterval(() => {
    void syncJobsFromSdkState(jobs, subscribers, version).then(() => {
      for (const entry of jobs.values()) {
        if (entry.sessionId === undefined || isTerminalStatus(entry.info.status)) {
          continue;
        }
        broadcast(subscribers, { type: "job:updated", job: { ...entry.info } }, version);
      }
    });
  }, 1000);
  restoreTimer.unref?.();

  function killJob(id: string): Promise<boolean> {
    return (async () => {
      const entry = jobs.get(id);
      if (entry === undefined || isTerminalStatus(entry.info.status)) {
        return false;
      }
      if (entry.sessionId === undefined || entry.sdk === undefined) {
        entry.info.status = "killed";
        entry.info.endedAt = Date.now();
        broadcast(subscribers, { type: "job:completed", job: { ...entry.info } }, version);
        return true;
      }
      try {
        const cancelled = await entry.sdk.cancel({ sessionId: entry.sessionId });
        syncJobInfoFromState(entry.info, cancelled);
        broadcast(subscribers, { type: "job:completed", job: { ...entry.info } }, version);
        return true;
      } catch {
        return false;
      } finally {
        entry.sdk?.dispose();
        entry.sdk = undefined;
      }
    })();
  }

  async function killAll(): Promise<number> {
    let count = 0;
    for (const id of jobs.keys()) {
      if (await killJob(id)) {
        count += 1;
      }
    }
    return count;
  }

  const handle = createAgentJobsHandler({
    reviewArgs: args,
    jobs,
    capabilities,
    subscribers,
    version,
    killJob,
    killAll,
  });

  return {
    tour: {
      getTour: () => null,
      saveChecklist: () => {},
    },
    agentJobs: {
      killAll() {
        return killAll();
      },
      dispose() {
        clearInterval(restoreTimer);
        subscribers.clear();
      },
      handle,
    },
  };
}
