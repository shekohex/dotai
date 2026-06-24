import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
  type AgentToolUpdateCallback,
  type ExtensionContext,
  SessionManager,
  convertToLlm,
  serializeConversation,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import path from "node:path";
import { errorMessage } from "../../utils/error-message.js";
import { isRecord } from "../../utils/unknown-data.js";
import { streamModel } from "../pi-ai-models.js";
import {
  appendCurrentModelFallback,
  DEFAULT_MODEL_FALLBACKS,
  isAbortSignalAborted,
  modelForOpenAIResponses,
  resolveModelFallbackAuth,
  type ModelAuth,
} from "../model-fallbacks.js";

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based only on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Grounding rules:
- Do not infer beyond the transcript. If the transcript does not answer the question, say so.
- Prefer the latest relevant state when the transcript contains conflicting or superseded details.
- Mention concrete evidence briefly: quote short phrases, file paths, commands, commit hashes, or error messages that support the answer.
- Distinguish confirmed facts from uncertainty. Use "not found in the session" instead of guessing.

Be concise and direct.`;

type SessionQueryDetails = {
  sessionPath: string;
  sessionUuid: string;
  question: string;
  messageCount: number;
  answer: string;
};

type SessionMessages = Parameters<typeof convertToLlm>[0];

function isApiModel(value: unknown): value is Model<Api> {
  if (!isRecord(value)) {
    return false;
  }
  const candidate = value;
  return (
    typeof candidate.provider === "string" &&
    typeof candidate.id === "string" &&
    typeof candidate.api === "string"
  );
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

  const fallbackModels = appendCurrentModelFallback(
    DEFAULT_MODEL_FALLBACKS,
    isApiModel(ctx.model) ? ctx.model : undefined,
  );

  for (const fallbackModel of fallbackModels) {
    const modelAuth = await resolveModelFallbackAuth(ctx, fallbackModel, "Session query");
    if (modelAuth === undefined) {
      continue;
    }
    ctx.ui.notify(
      `Session query: analyzing ${messages.length} messages with ${modelAuth.model.id}...`,
      "info",
    );
    try {
      return await runSessionQuery(modelAuth, messages, request, signal, onUpdate);
    } catch (err) {
      if (isAbortSignalAborted(signal)) {
        return errorResult("Query was cancelled.");
      }
      ctx.ui.notify(
        `Session query failed with ${modelAuth.model.id}: ${errorMessage(err)}. Trying next fallback`,
        "warning",
      );
    }
  }

  return errorResult("Session query fallback list exhausted; no model could analyze the session.");
}

function loadSessionMessages(
  sessionPath: string,
  errorResult: (text: string) => {
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown } | SessionMessages> {
  if (!sessionPath.endsWith(".jsonl")) {
    return Promise.resolve(
      errorResult(`Invalid session path. Expected a .jsonl file, got: ${sessionPath}`),
    );
  }
  try {
    if (!existsSync(sessionPath)) {
      return Promise.resolve(errorResult(`Session file not found: ${sessionPath}`));
    }
  } catch (err) {
    return Promise.resolve(errorResult(`Error checking session file: ${errorMessage(err)}`));
  }

  let sessionManager: SessionManager;
  try {
    sessionManager = SessionManager.open(sessionPath);
  } catch (err) {
    return Promise.resolve(errorResult(`Error loading session: ${errorMessage(err)}`));
  }

  return Promise.resolve(
    sessionManager
      .getBranch()
      .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
      .map((entry) => entry.message),
  );
}

async function runSessionQuery(
  modelAuth: ModelAuth,
  messages: SessionMessages,
  request: { sessionPath: string; question: string; sessionUuid: string },
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
) {
  const conversationText = serializeConversation(convertToLlm(messages));
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
  const queryStream = streamModel(
    modelForOpenAIResponses(modelAuth.model),
    { systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: modelAuth.apiKey, headers: modelAuth.headers, signal },
  );
  await emitSessionQueryPartials(queryStream, request, messages.length, onUpdate);
  const response = await queryStream.result();
  return finalizeSessionQueryResponse(response, request, messages.length);
}

async function emitSessionQueryPartials(
  queryStream: ReturnType<typeof streamModel>,
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
  response: Awaited<ReturnType<ReturnType<typeof streamModel>["result"]>>,
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
