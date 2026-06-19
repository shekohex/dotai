import { randomUUID } from "node:crypto";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { getCurrentPiSessionContext } from "../current-pi-session.js";
import {
  buildLaunchCommand,
  createDefaultMuxAdapter,
  createSubagentSDK,
} from "../../../subagent-sdk/index.js";
import type { SubagentHandle, SubagentSDK } from "../../../subagent-sdk/sdk-types.js";
import type { SubagentChildIpcEvent } from "../../../subagent-sdk/ipc.js";
import { errorMessage } from "../../../utils/error-message.js";
import { isRecord } from "../../../utils/unknown-data.js";

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

function sseData(value: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

function sseDone(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

function createCompletedSseResponse(message: unknown): Response {
  return new Response(Buffer.concat([Buffer.from(sseData(message)), Buffer.from(sseDone())]), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function extractTextFromMessage(value: unknown): string {
  if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content)) {
    return "";
  }
  return value.content
    .map((item) => {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
        return "";
      }
      return item.text;
    })
    .join("");
}

function extractTextDelta(event: SubagentChildIpcEvent): string | null {
  if (event.type !== "message_update") {
    return null;
  }
  const assistantEvent = event.assistantMessageEvent;
  if (!isRecord(assistantEvent) || assistantEvent.type !== "text_delta") {
    return null;
  }
  return typeof assistantEvent.delta === "string" ? assistantEvent.delta : null;
}

function extractMessageEndText(event: SubagentChildIpcEvent): string | null {
  if (event.type !== "message_end") {
    return null;
  }
  const text = extractTextFromMessage(event.message);
  return text.length > 0 ? text : null;
}

function createSdk() {
  const currentSession = getCurrentPiSessionContext();
  if (currentSession === undefined) {
    throw new Error("No active Pi session available for Ask AI.");
  }
  const sdk = createSubagentSDK(currentSession.pi, {
    adapter: createDefaultMuxAdapter(currentSession.pi),
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

async function startHandle(session: AIReviewSession, prompt: string, cwd: string): Promise<void> {
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

async function sendFollowUp(handle: SubagentHandle, prompt: string): Promise<void> {
  const currentSession = getCurrentPiSessionContext();
  if (currentSession === undefined) {
    throw new Error("No active Pi session available for Ask AI.");
  }
  await handle.sendMessage({ message: prompt, delivery: "followUp" }, currentSession.ctx);
}

function createStreamingQueryResponse(args: {
  session: AIReviewSession;
  prompt: string;
  cwd: string;
}): Response {
  let removeTextDeltaListener: (() => void) | undefined;
  let removeMessageEndListener: (() => void) | undefined;
  let removeAgentEndListener: (() => void) | undefined;
  let streamedText = "";
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const closeStream = () => {
        if (closed) {
          return;
        }
        closed = true;
        removeTextDeltaListener?.();
        removeMessageEndListener?.();
        removeAgentEndListener?.();
        controller.enqueue(sseDone());
        controller.close();
      };
      try {
        if (args.session.handle === undefined) {
          await startHandle(args.session, args.prompt, args.cwd);
        }
        const handle = args.session.handle;
        if (handle === undefined) throw new Error("Ask AI subagent did not start.");
        removeTextDeltaListener = handle.on("message_update", (event) => {
          const delta = extractTextDelta(event);
          if (delta === null || delta.length === 0) {
            return;
          }
          streamedText += delta;
          controller.enqueue(sseData({ type: "text_delta", delta }));
        });
        removeMessageEndListener = handle.on("message_end", (event) => {
          if (streamedText.length > 0) {
            return;
          }
          const text = extractMessageEndText(event);
          if (text === null) {
            return;
          }
          streamedText = text;
          controller.enqueue(sseData({ type: "text", text }));
        });
        removeAgentEndListener = handle.on("agent_end", () => {
          closeStream();
        });
        if (handle.getState().status !== "running") {
          await sendFollowUp(handle, args.prompt);
        }
        const terminal = await handle.waitForCompletion();
        if (!closed && streamedText.length === 0) {
          const text = terminal.summary ?? (await handle.captureOutput(2000)).text;
          if (text.length > 0) {
            controller.enqueue(sseData({ type: "result", result: text }));
          }
        }
        closeStream();
      } catch (error) {
        removeTextDeltaListener?.();
        removeMessageEndListener?.();
        removeAgentEndListener?.();
        if (closed) {
          return;
        }
        closed = true;
        controller.enqueue(
          sseData({ type: "error", error: errorMessage(error), code: "query_error" }),
        );
        controller.enqueue(sseDone());
        controller.close();
      }
    },
    cancel() {
      removeTextDeltaListener?.();
      removeMessageEndListener?.();
      removeAgentEndListener?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
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
              capabilities: { streaming: true, tools: true, fork: false, permissions: false },
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
        return createStreamingQueryResponse({ session, prompt, cwd: args.resolveAgentCwd() });
      } catch (error) {
        return createCompletedSseResponse({
          type: "error",
          error: errorMessage(error),
          code: "query_error",
        });
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
