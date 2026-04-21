import { stream, type Api, type Message, type Model } from "@mariozechner/pi-ai";
import {
  type AgentToolUpdateCallback,
  type ExtensionContext,
  SessionManager,
  convertToLlm,
  serializeConversation,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import path from "node:path";

const QUERY_PROVIDER = "gemini" as const;
const QUERY_MODEL = "gemini-3.1-flash-lite-preview" as const;

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

type SessionQueryDetails = {
  sessionPath: string;
  sessionUuid: string;
  question: string;
  messageCount: number;
  answer: string;
};

type SessionMessages = Parameters<typeof convertToLlm>[0];

function isApiModel(value: unknown): value is Model<Api> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as { provider?: unknown; id?: unknown; api?: unknown };
  return (
    typeof candidate.provider === "string" &&
    typeof candidate.id === "string" &&
    typeof candidate.api === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAssistantText(
  content: Array<{ type: string; text?: string } | { type: string; thinking?: string }>,
): string {
  return content
    .flatMap((item) =>
      item.type === "text" && "text" in item && typeof item.text === "string" ? [item.text] : [],
    )
    .join("\n");
}

function extractSessionUuid(sessionPath: string): string {
  if (!sessionPath) return "...";
  const filename = path.basename(sessionPath, ".jsonl");
  const separatorIndex = filename.indexOf("_");
  if (separatorIndex === -1) return filename;
  const uuid = filename.slice(separatorIndex + 1);
  return uuid.length >= 8 ? uuid.slice(0, 8) : uuid;
}

export function createSessionQueryRequest(params: { sessionPath: string; question: string }): {
  sessionPath: string;
  question: string;
  sessionUuid: string;
} {
  return {
    sessionPath: params.sessionPath,
    question: params.question,
    sessionUuid: extractSessionUuid(params.sessionPath),
  };
}

export async function executeSessionQueryRequest(
  request: { sessionPath: string; question: string; sessionUuid: string },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
) {
  const errorResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
    details: {
      error: true,
      sessionPath: request.sessionPath,
      sessionUuid: request.sessionUuid,
      question: request.question,
    },
  });
  const loadResult = await loadSessionMessages(request.sessionPath, errorResult);
  if ("content" in loadResult) {
    return loadResult;
  }
  const messages = loadResult;
  if (messages.length === 0) {
    return {
      content: [{ type: "text" as const, text: "Session is empty - no messages found." }],
      details: {
        empty: true,
        sessionPath: request.sessionPath,
        sessionUuid: request.sessionUuid,
        question: request.question,
        messageCount: 0,
        answer: "",
      },
    };
  }

  const model =
    ctx.modelRegistry.find(QUERY_PROVIDER, QUERY_MODEL) ??
    (isApiModel(ctx.model) ? ctx.model : undefined);
  if (model === undefined) {
    return errorResult("No model available to analyze the session.");
  }
  return runSessionQuery(model, messages, request, signal, onUpdate, ctx, errorResult);
}

async function loadSessionMessages(
  sessionPath: string,
  errorResult: (text: string) => {
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown } | SessionMessages> {
  if (!sessionPath.endsWith(".jsonl")) {
    return errorResult(`Invalid session path. Expected a .jsonl file, got: ${sessionPath}`);
  }
  try {
    const fs = await import("node:fs");
    if (!fs.existsSync(sessionPath)) {
      return errorResult(`Session file not found: ${sessionPath}`);
    }
  } catch (err) {
    return errorResult(`Error checking session file: ${errorMessage(err)}`);
  }

  let sessionManager: SessionManager;
  try {
    sessionManager = SessionManager.open(sessionPath);
  } catch (err) {
    return errorResult(`Error loading session: ${errorMessage(err)}`);
  }

  return sessionManager
    .getBranch()
    .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
    .map((entry) => entry.message);
}

async function runSessionQuery(
  model: Model<Api>,
  messages: SessionMessages,
  request: { sessionPath: string; question: string; sessionUuid: string },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  errorResult: (text: string) => {
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  },
) {
  const conversationText = serializeConversation(convertToLlm(messages));
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return errorResult(`Auth failed: ${auth.error}`);
    }
    const userMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${request.question}`,
        },
      ],
      timestamp: Date.now(),
    };
    const queryStream = stream(
      model,
      { systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );
    await emitSessionQueryPartials(queryStream, request, messages.length, onUpdate);
    const response = await queryStream.result();
    return finalizeSessionQueryResponse(response, request, messages.length);
  } catch (err) {
    return errorResult(`Error querying session: ${errorMessage(err)}`);
  }
}

async function emitSessionQueryPartials(
  queryStream: ReturnType<typeof stream>,
  request: { sessionPath: string; question: string; sessionUuid: string },
  messageCount: number,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): Promise<void> {
  let lastPartialAnswer = "";
  for await (const event of queryStream) {
    if (event.type !== "text_start" && event.type !== "text_delta" && event.type !== "text_end") {
      continue;
    }
    const partialAnswer = getAssistantText(event.partial.content).trim();
    if (!partialAnswer || partialAnswer === lastPartialAnswer) {
      continue;
    }
    lastPartialAnswer = partialAnswer;
    onUpdate?.({
      content: [{ type: "text", text: partialAnswer }],
      details: {
        sessionPath: request.sessionPath,
        sessionUuid: request.sessionUuid,
        question: request.question,
        messageCount,
        answer: partialAnswer,
      } satisfies SessionQueryDetails,
    });
  }
}

function finalizeSessionQueryResponse(
  response: Awaited<ReturnType<ReturnType<typeof stream>["result"]>>,
  request: { sessionPath: string; question: string; sessionUuid: string },
  messageCount: number,
) {
  const text = getAssistantText(response.content).trim();
  if (response.stopReason === "aborted") {
    return {
      content: [{ type: "text" as const, text: "Query was cancelled." }],
      details: {
        cancelled: true,
        sessionPath: request.sessionPath,
        sessionUuid: request.sessionUuid,
        question: request.question,
        messageCount,
        answer: "",
      },
    };
  }
  if (response.stopReason === "error") {
    throw new Error(
      response.errorMessage ?? (text.length > 0 ? text : undefined) ?? "Session query failed",
    );
  }
  return {
    content: [{ type: "text" as const, text: text || "No answer returned." }],
    details: {
      sessionPath: request.sessionPath,
      sessionUuid: request.sessionUuid,
      question: request.question,
      messageCount,
      answer: text,
    } satisfies SessionQueryDetails,
  };
}
