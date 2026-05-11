import http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeSubagent } from "../src/subagent-sdk/types.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

const waitForCompletion = vi.fn();
const cancelMock = vi.fn();
const restoreMock = vi.fn();
const listMock = vi.fn<() => RuntimeSubagent[]>();
const startReviewModeSubagentMock = vi.fn();
const getCurrentPiSessionContextMock = vi.fn();

vi.mock("../src/extensions/plannotator/server/review-mode-launch.js", () => ({
  ReviewStructuredResultSchema: {
    type: "object",
    properties: {},
  },
  launchReviewModeSubagent: vi.fn(),
  startReviewModeSubagent: startReviewModeSubagentMock,
}));

vi.mock("../src/extensions/plannotator/current-pi-session.js", () => ({
  getCurrentPiSessionContext: getCurrentPiSessionContextMock,
}));

describe("plannotator review agent jobs", () => {
  beforeEach(() => {
    vi.useRealTimers();
    waitForCompletion.mockReset();
    cancelMock.mockReset();
    restoreMock.mockReset();
    listMock.mockReset();
    startReviewModeSubagentMock.mockReset();
    getCurrentPiSessionContextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createContext(): ExtensionContext {
    return {
      cwd: process.cwd(),
      hasUI: false,
      ui: {
        setWidget() {},
        notify() {},
        onTerminalInput(handler: (data: string) => unknown) {
          return handler;
        },
      },
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getSessionName: () => undefined,
      },
      shutdown() {},
    } as unknown as ExtensionContext;
  }

  async function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>,
  ): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      void handler(req, res, new URL(req.url ?? "/", "http://127.0.0.1")).then((handled) => {
        if (!handled) {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return server;
  }

  async function requestJson(
    server: http.Server,
    options: {
      method: string;
      path: string;
      body?: unknown;
    },
  ): Promise<{ statusCode: number; json: unknown }> {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Server did not expose port");
    }
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: options.path,
          method: options.method,
          headers: options.body === undefined ? undefined : { "content-type": "application/json" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              json: body.length > 0 ? (JSON.parse(body) as unknown) : null,
            });
          });
        },
      );
      req.on("error", reject);
      if (options.body !== undefined) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  async function openSse(server: http.Server): Promise<{
    close: () => void;
    waitForEvent: (matcher: (payload: string) => boolean) => Promise<string>;
  }> {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Server did not expose port");
    }
    const events: string[] = [];
    const waiters: Array<{
      matcher: (payload: string) => boolean;
      resolve: (value: string) => void;
    }> = [];
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/api/agents/jobs/stream",
      method: "GET",
    });
    req.end();
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        const parts = String(chunk)
          .split("\n\n")
          .filter((part) => part.startsWith("data: "))
          .map((part) => part.slice("data: ".length));
        for (const payload of parts) {
          events.push(payload);
          for (const waiter of [...waiters]) {
            if (waiter.matcher(payload)) {
              waiter.resolve(payload);
              waiters.splice(waiters.indexOf(waiter), 1);
            }
          }
        }
      });
    });
    return {
      close: () => req.destroy(),
      waitForEvent: async (matcher) => {
        const existing = events.find(matcher);
        if (existing !== undefined) {
          return existing;
        }
        return await new Promise((resolve) => {
          waiters.push({ matcher, resolve });
        });
      },
    };
  }

  it("reports running status after launch and terminal status after completion", async () => {
    const module = await import("../src/extensions/plannotator/server/review-agent-jobs.js");
    const completion = createDeferred<RuntimeSubagent>();
    const runningState: RuntimeSubagent = {
      sessionId: "child-1",
      parentSessionId: "session-1",
      name: "review",
      mode: "review",
      modeLabel: "review",
      paneId: "%1",
      status: "running",
      event: "started",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      cwd: process.cwd(),
      persisted: true,
      completion: false,
      autoExit: false,
      outputFormat: { type: "json_schema", schema: {} },
      sessionPath: "/tmp/child-1.jsonl",
    };
    const completedState: RuntimeSubagent = {
      ...runningState,
      status: "completed",
      event: "completed",
      completedAt: Date.now() + 100,
      updatedAt: Date.now() + 100,
      structured: {
        correctness: "Issues Found",
        explanation: "One finding.",
        confidence: 0.9,
        findings: [
          {
            filePath: "src/app.ts",
            lineStart: 4,
            lineEnd: 4,
            text: "Bug.",
          },
        ],
      },
    };

    waitForCompletion.mockReturnValue(completion.promise);
    listMock.mockReturnValue([runningState]);
    restoreMock.mockResolvedValue([]);
    cancelMock.mockResolvedValue({ ...runningState, status: "cancelled", event: "cancelled" });
    startReviewModeSubagentMock.mockResolvedValue({
      sdk: {
        restore: restoreMock,
        list: listMock,
        cancel: cancelMock,
        dispose() {},
      },
      state: runningState,
      prompt: "review task",
      handle: {
        waitForCompletion,
      },
    });
    getCurrentPiSessionContextMock.mockReturnValue({
      pi: { exec: vi.fn() },
      ctx: createContext(),
    });

    const addedAnnotations: unknown[][] = [];
    const jobs = module.createReviewAgentJobs({
      canLaunchReviewAgent: () => true,
      resolveAgentCwd: () => process.cwd(),
      getCurrentPatch: () => "diff --git a/a b/a",
      getCurrentDiffType: () => "uncommitted",
      getCurrentBase: () => "main",
      getCurrentPrDiffScope: () => "stack",
      getPrMeta: () => undefined,
      addAnnotations: (annotations) => {
        addedAnnotations.push(annotations);
      },
    });
    const server = await startServer(jobs.agentJobs.handle);
    const sse = await openSse(server);

    try {
      const post = await requestJson(server, {
        method: "POST",
        path: "/api/agents/jobs",
        body: { provider: "review" },
      });
      expect(post.statusCode).toBe(201);
      expect(post.json).toMatchObject({
        job: {
          provider: "review",
          status: "running",
          prompt: "review task",
        },
      });

      const updatedEvent = await sse.waitForEvent((payload) =>
        payload.includes('"type":"job:updated"'),
      );
      expect(updatedEvent).toContain('"status":"running"');

      const listWhileRunning = await requestJson(server, {
        method: "GET",
        path: "/api/agents/jobs",
      });
      expect(listWhileRunning.json).toMatchObject({
        jobs: [{ status: "running" }],
      });

      completion.resolve(completedState);
      const completedEvent = await sse.waitForEvent(
        (payload) =>
          payload.includes('"type":"job:completed"') && payload.includes('"status":"done"'),
      );
      expect(completedEvent).toContain('"correctness":"Issues Found"');
      expect(addedAnnotations).toHaveLength(1);

      const listAfterCompletion = await requestJson(server, {
        method: "GET",
        path: "/api/agents/jobs",
      });
      expect(listAfterCompletion.json).toMatchObject({
        jobs: [
          {
            status: "done",
            summary: {
              correctness: "Issues Found",
            },
          },
        ],
      });
    } finally {
      sse.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("cancels a running review job and exposes killed status", async () => {
    const module = await import("../src/extensions/plannotator/server/review-agent-jobs.js");
    const runningState: RuntimeSubagent = {
      sessionId: "child-2",
      parentSessionId: "session-1",
      name: "review",
      mode: "review",
      modeLabel: "review",
      paneId: "%2",
      status: "running",
      event: "started",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      cwd: process.cwd(),
      persisted: true,
      completion: false,
      autoExit: false,
      outputFormat: { type: "json_schema", schema: {} },
      sessionPath: "/tmp/child-2.jsonl",
    };
    const cancelledState: RuntimeSubagent = {
      ...runningState,
      status: "cancelled",
      event: "cancelled",
      completedAt: Date.now() + 50,
      updatedAt: Date.now() + 50,
    };

    waitForCompletion.mockReturnValue(new Promise<RuntimeSubagent>(() => {}));
    listMock.mockReturnValue([runningState]);
    restoreMock.mockResolvedValue([]);
    cancelMock.mockResolvedValue(cancelledState);
    startReviewModeSubagentMock.mockResolvedValue({
      sdk: {
        restore: restoreMock,
        list: listMock,
        cancel: cancelMock,
        dispose() {},
      },
      state: runningState,
      prompt: "review task",
      handle: {
        waitForCompletion,
      },
    });
    getCurrentPiSessionContextMock.mockReturnValue({
      pi: { exec: vi.fn() },
      ctx: createContext(),
    });

    const jobs = module.createReviewAgentJobs({
      canLaunchReviewAgent: () => true,
      resolveAgentCwd: () => process.cwd(),
      getCurrentPatch: () => "diff --git a/a b/a",
      getCurrentDiffType: () => "uncommitted",
      getCurrentBase: () => "main",
      getCurrentPrDiffScope: () => "stack",
      getPrMeta: () => undefined,
      addAnnotations() {},
    });
    const server = await startServer(jobs.agentJobs.handle);

    try {
      const post = await requestJson(server, {
        method: "POST",
        path: "/api/agents/jobs",
        body: { provider: "review" },
      });
      const jobId = String((post.json as { job: { id: string } }).job.id);

      const del = await requestJson(server, {
        method: "DELETE",
        path: `/api/agents/jobs/${jobId}`,
      });
      expect(del.statusCode).toBe(200);
      expect(cancelMock).toHaveBeenCalledWith({ sessionId: "child-2" });

      const listAfterCancel = await requestJson(server, {
        method: "GET",
        path: "/api/agents/jobs",
      });
      expect(listAfterCancel.json).toMatchObject({
        jobs: [{ id: jobId, status: "killed" }],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("stops restore polling when agent jobs are disposed", async () => {
    vi.useFakeTimers();
    const module = await import("../src/extensions/plannotator/server/review-agent-jobs.js");

    restoreMock.mockResolvedValue([]);
    listMock.mockReturnValue([]);
    const jobs = module.createReviewAgentJobs({
      canLaunchReviewAgent: () => true,
      resolveAgentCwd: () => process.cwd(),
      getCurrentPatch: () => "diff --git a/a b/a",
      getCurrentDiffType: () => "uncommitted",
      getCurrentBase: () => "main",
      getCurrentPrDiffScope: () => "stack",
      getPrMeta: () => undefined,
      addAnnotations() {},
    });

    jobs.agentJobs.dispose();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(restoreMock).not.toHaveBeenCalled();
  });

  it("marks launch failures as failed instead of leaving phantom starting jobs", async () => {
    const module = await import("../src/extensions/plannotator/server/review-agent-jobs.js");

    startReviewModeSubagentMock.mockRejectedValue(new Error("tmux unavailable"));
    getCurrentPiSessionContextMock.mockReturnValue({
      pi: { exec: vi.fn() },
      ctx: createContext(),
    });

    const jobs = module.createReviewAgentJobs({
      canLaunchReviewAgent: () => true,
      resolveAgentCwd: () => process.cwd(),
      getCurrentPatch: () => "diff --git a/a b/a",
      getCurrentDiffType: () => "uncommitted",
      getCurrentBase: () => "main",
      getCurrentPrDiffScope: () => "stack",
      getPrMeta: () => undefined,
      addAnnotations() {},
    });
    const server = await startServer(jobs.agentJobs.handle);

    try {
      const post = await requestJson(server, {
        method: "POST",
        path: "/api/agents/jobs",
        body: { provider: "review" },
      });
      expect(post.statusCode).toBe(500);
      expect(post.json).toMatchObject({ error: "tmux unavailable" });

      const listed = await requestJson(server, {
        method: "GET",
        path: "/api/agents/jobs",
      });
      expect(listed.json).toMatchObject({
        jobs: [
          {
            status: "failed",
            error: "tmux unavailable",
          },
        ],
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects AI review launch when PR session lacks local checkout access", async () => {
    const module = await import("../src/extensions/plannotator/server/review-agent-jobs.js");
    getCurrentPiSessionContextMock.mockReturnValue({
      pi: { exec: vi.fn() },
      ctx: createContext(),
    });

    const jobs = module.createReviewAgentJobs({
      canLaunchReviewAgent: () => false,
      resolveAgentCwd: () => process.cwd(),
      getCurrentPatch: () => "diff --git a/a b/a",
      getCurrentDiffType: () => "uncommitted",
      getCurrentBase: () => "main",
      getCurrentPrDiffScope: () => "stack",
      getPrMeta: () => ({ url: "https://example.com/pr/1" }),
      addAnnotations() {},
    });
    const server = await startServer(jobs.agentJobs.handle);

    try {
      const post = await requestJson(server, {
        method: "POST",
        path: "/api/agents/jobs",
        body: { provider: "review" },
      });
      expect(post.statusCode).toBe(500);
      expect(post.json).toMatchObject({
        error:
          "AI review agent requires local checkout access for this review session. Reopen review with local access enabled.",
      });
      expect(startReviewModeSubagentMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
