import { randomUUID } from "node:crypto";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { getCurrentPiSessionContext } from "../current-pi-session.js";
import { buildLaunchCommand, createSubagentSDK, TmuxAdapter } from "../../../subagent-sdk/index.js";
import type { SubagentHandle, SubagentSDK } from "../../../subagent-sdk/sdk-types.js";
import { errorMessage } from "../../../utils/error-message.js";

const CreateSessionSchema = Type.Object({
  context: Type.Object(
    {
      mode: Type.String(),
      review: Type.Optional(Type.Object({ patch: Type.String() }, { additionalProperties: true })),
    },
    { additionalProperties: true },
  ),
  providerId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  maxTurns: Type.Optional(Type.Number()),
  maxBudgetUsd: Type.Optional(Type.Number()),
  reasoningEffort: Type.Optional(Type.String()),
});

const QuerySchema = Type.Object({
  sessionId: Type.String(),
  prompt: Type.String(),
  contextUpdate: Type.Optional(Type.String()),
});

const SessionIdSchema = Type.Object({
  sessionId: Type.String(),
});

type CreateSessionBody = Static<typeof CreateSessionSchema>;
type QueryBody = Static<typeof QuerySchema>;
type SessionIdBody = Static<typeof SessionIdSchema>;

type AIReviewSession = {
  id: string;
  mode: string;
  patch: string;
  createdAt: number;
  lastActiveAt: number;
  label?: string;
  sdk?: SubagentSDK;
  handle?: SubagentHandle;
};

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function createSseResponse(messages: unknown[]): Response {
  const encoder = new TextEncoder();
  const chunks = messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join("");
  return new Response(encoder.encode(`${chunks}data: [DONE]\n\n`), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function createSdk() {
  const currentSession = getCurrentPiSessionContext();
  if (currentSession === undefined) {
    throw new Error("No active Pi session available for Ask AI.");
  }
  const sdk = createSubagentSDK(currentSession.pi, {
    adapter: new TmuxAdapter(
      (command, args, execOptions) => currentSession.pi.exec(command, args, execOptions),
      process.cwd(),
    ),
    buildLaunchCommand,
  });
  return { sdk, ctx: currentSession.ctx };
}

function buildTask(session: AIReviewSession, prompt: string): string {
  const context =
    session.patch.length > 0
      ? `Review patch context:\n\n\`\`\`diff\n${session.patch}\n\`\`\`\n\n`
      : "";
  return `${context}${prompt}`;
}

async function ensureHandle(session: AIReviewSession, prompt: string, cwd: string): Promise<void> {
  if (session.handle !== undefined) {
    const currentSession = getCurrentPiSessionContext();
    if (currentSession === undefined) {
      throw new Error("No active Pi session available for Ask AI.");
    }
    await session.handle.sendMessage({ message: prompt, delivery: "followUp" }, currentSession.ctx);
    return;
  }
  const { sdk, ctx } = createSdk();
  session.sdk = sdk;
  const started = await sdk.start(
    {
      name: "ask-ai",
      task: buildTask(session, prompt),
      mode: "ask",
      cwd,
      persisted: true,
      completion: false,
      outputFormat: { type: "text" },
    },
    ctx,
  );
  session.handle = started.handle;
}

export function createReviewAIEndpoints(args: { resolveAgentCwd: () => string }) {
  const sessions = new Map<string, AIReviewSession>();
  const endpoints = {
    "/api/ai/capabilities": () =>
      Promise.resolve(
        jsonResponse({
          available: getCurrentPiSessionContext() !== undefined,
          providers: [
            {
              id: "pi-subagent",
              name: "Pi Subagent",
              capabilities: { streaming: false, tools: true, fork: false, permissions: false },
              models: [],
            },
          ],
          defaultProvider: "pi-subagent",
        }),
      ),
    "/api/ai/session": async (req: Request) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body: unknown = await req.json();
      if (!Value.Check(CreateSessionSchema, body)) {
        return jsonResponse({ error: "Invalid request" }, 400);
      }
      const payload: CreateSessionBody = body;
      const id = randomUUID();
      sessions.set(id, {
        id,
        mode: payload.context.mode,
        patch: payload.context.review?.patch ?? "",
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      return jsonResponse({ sessionId: id, mode: payload.context.mode, createdAt: Date.now() });
    },
    "/api/ai/query": async (req: Request) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body: unknown = await req.json();
      if (!Value.Check(QuerySchema, body)) return jsonResponse({ error: "Invalid request" }, 400);
      const payload: QueryBody = body;
      const session = sessions.get(payload.sessionId);
      if (session === undefined) return jsonResponse({ error: "Session not found" }, 404);
      session.lastActiveAt = Date.now();
      session.label ??= payload.prompt.slice(0, 80);
      try {
        const prompt =
          payload.contextUpdate !== undefined && payload.contextUpdate.length > 0
            ? `[Context update: the user has made changes since this conversation started]\n${payload.contextUpdate}\n\n${payload.prompt}`
            : payload.prompt;
        await ensureHandle(session, prompt, args.resolveAgentCwd());
        const terminal = await session.handle?.waitForCompletion();
        const text = terminal?.summary ?? (await session.handle?.captureOutput(2000))?.text ?? "";
        return createSseResponse([{ type: "result", result: text }]);
      } catch (error) {
        return createSseResponse([
          { type: "error", error: errorMessage(error), code: "query_error" },
        ]);
      }
    },
    "/api/ai/abort": async (req: Request) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const body: unknown = await req.json();
      if (!Value.Check(SessionIdSchema, body))
        return jsonResponse({ error: "Invalid request" }, 400);
      const payload: SessionIdBody = body;
      const session = sessions.get(payload.sessionId);
      if (session === undefined) return jsonResponse({ error: "Session not found" }, 404);
      await session.handle?.cancel();
      session.sdk?.dispose();
      sessions.delete(payload.sessionId);
      return jsonResponse({ ok: true });
    },
    "/api/ai/permission": (req: Request) => {
      if (req.method !== "POST") {
        return Promise.resolve(new Response("Method not allowed", { status: 405 }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    },
    "/api/ai/sessions": () =>
      Promise.resolve(
        jsonResponse(
          [...sessions.values()].map((session) => ({
            sessionId: session.id,
            mode: session.mode,
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
            isActive: session.handle?.getState().status === "running",
            label: session.label,
          })),
        ),
      ),
  };
  return {
    endpoints,
    dispose: () => {
      for (const session of sessions.values()) {
        session.sdk?.dispose();
      }
      sessions.clear();
    },
  };
}
