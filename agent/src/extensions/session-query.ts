import { stream, type Message } from "@mariozechner/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  SessionManager,
  convertToLlm,
  getMarkdownTheme,
  serializeConversation,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import {
  createTextComponent,
  formatDurationHuman,
  formatToolRail,
  getTextContent,
  renderStreamingPreview,
  styleToolOutput,
  summarizeLineCount,
} from "./coreui/tools.js";

const TOOL_TEXT_PADDING_X = 0;
const TOOL_TEXT_PADDING_Y = 0;
const STREAM_PREVIEW_LINE_LIMIT = 5;

const QUERY_PROVIDER = "gemini" as const;
const QUERY_MODEL = "gemini-3.1-flash-lite-preview" as const;

type SessionQueryDetails = {
  sessionPath: string;
  sessionUuid: string;
  question: string;
  messageCount: number;
  answer: string;
};

type SessionQueryToolDetails =
  | SessionQueryDetails
  | { error: true; sessionPath: string; sessionUuid: string; question: string }
  | {
      empty: true;
      sessionPath: string;
      sessionUuid: string;
      question: string;
      messageCount: number;
      answer: string;
    }
  | {
      cancelled: true;
      sessionPath: string;
      sessionUuid: string;
      question: string;
      messageCount: number;
      answer: string;
    };

type SessionQueryRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
  callComponent?: Text;
  callText?: string;
};

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

export const sessionQueryTool = defineTool({
  name: "session_query",
  label: "query",
  renderShell: "self",
  description:
    "Query a previous pi session file for context, decisions, or information. Use when you need to look up what happened in a parent session or any other session.",
  parameters: Type.Object({
    sessionPath: Type.String({
      description:
        "Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl)",
    }),
    question: Type.String({
      description:
        "What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
    }),
  }),
  renderCall(args, theme, context) {
    const state = syncRenderState(context, context.isPartial);
    const rail = formatToolRail(theme, context);

    const phase = context.isError ? "error" : context.isPartial ? "pending" : "success";
    const status =
      phase === "error"
        ? theme.bold(theme.fg("error", "queried"))
        : phase === "success"
          ? theme.bold(theme.fg("dim", "queried"))
          : theme.bold(theme.fg("dim", "querying"));
    const sessionLabel = extractSessionUuid(args.sessionPath || "");
    const question =
      typeof args.question === "string" && args.question.trim().length > 0
        ? args.question.trim()
        : "...";

    const text = `${rail}${status} ${theme.fg("muted", sessionLabel)}${theme.fg("dim", " → ")}${theme.fg("muted", truncateQuestion(question))}`;
    return setCallComponent(state, context.lastComponent, text);
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const state = syncRenderState(context, isPartial);
    const rail = formatToolRail(theme, context);
    const textContent = getTextContent(result);
    const details = result.details as SessionQueryToolDetails | undefined;
    const elapsedMs = getElapsedMs(state);

    if (context.isError) {
      if (expanded) {
        return createTextComponent(
          context.lastComponent,
          `${rail}${theme.fg("error", "↳ ")}${theme.fg("error", textContent || "Session query failed.")}`,
        );
      }
      return createTextComponent(context.lastComponent, "");
    }

    if (isPartial) {
      const renderedText = styleToolOutput(textContent, theme);
      const footer = elapsedMs !== undefined ? formatDurationHuman(elapsedMs) : "0s";

      if (renderedText) {
        return renderStreamingPreview(renderedText, theme, context.lastComponent, {
          expanded,
          footer: expanded
            ? footer
            : `${summarizeLineCount(countRenderedLines(textContent))} so far (${footer})`,
          tailLines: STREAM_PREVIEW_LINE_LIMIT,
        });
      }

      return createTextComponent(
        context.lastComponent,
        `${rail}${theme.fg("dim", "↳ ")}${theme.fg("muted", `loading session (${footer})`)}`,
      );
    }

    const answer = textContent;
    const summary = [
      theme.fg("muted", answer ? "answered" : "no response"),
      elapsedMs !== undefined ? theme.fg("muted", `took ${formatDurationHuman(elapsedMs)}`) : "",
    ]
      .filter(Boolean)
      .join(`${theme.fg("muted", " · ")}`);

    if (!expanded) {
      applyCollapsedSummaryToCall(state, `${theme.fg("muted", " · ")}${summary}`);
      return createTextComponent(context.lastComponent, "");
    }

    const question =
      details && "question" in details ? details.question : (context.args?.question ?? "");
    const container =
      context.lastComponent instanceof Container ? context.lastComponent : new Container();
    container.clear();
    container.addChild(
      new Text(
        `${rail}${theme.fg("muted", "Question:")} ${theme.fg("accent", question)}`,
        TOOL_TEXT_PADDING_X,
        TOOL_TEXT_PADDING_Y,
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(
      new Markdown(
        answer.trim() || "No answer returned.",
        TOOL_TEXT_PADDING_X,
        TOOL_TEXT_PADDING_Y,
        getMarkdownTheme(),
        {
          color: (text: string) => theme.fg("toolOutput", text),
        },
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${rail}${theme.fg("dim", "↳ ")}${summary}`,
        TOOL_TEXT_PADDING_X,
        TOOL_TEXT_PADDING_Y,
      ),
    );
    return container;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const { sessionPath, question } = params;

    const sessionUuid = extractSessionUuid(sessionPath);

    const errorResult = (text: string) => ({
      content: [{ type: "text" as const, text }],
      details: { error: true, sessionPath, sessionUuid, question },
    });

    if (!sessionPath.endsWith(".jsonl")) {
      return errorResult(`Invalid session path. Expected a .jsonl file, got: ${sessionPath}`);
    }

    try {
      const fs = await import("node:fs");
      if (!fs.existsSync(sessionPath)) {
        return errorResult(`Session file not found: ${sessionPath}`);
      }
    } catch (err) {
      return errorResult(`Error checking session file: ${err}`);
    }

    let sessionManager: SessionManager;
    try {
      sessionManager = SessionManager.open(sessionPath);
    } catch (err) {
      return errorResult(`Error loading session: ${err}`);
    }

    const branch = sessionManager.getBranch();
    const messages = branch
      .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
      .map((entry) => entry.message);

    if (messages.length === 0) {
      return {
        content: [{ type: "text" as const, text: "Session is empty - no messages found." }],
        details: { empty: true, sessionPath, sessionUuid, question, messageCount: 0, answer: "" },
      };
    }

    const llmMessages = convertToLlm(messages);
    const conversationText = serializeConversation(llmMessages);

    const model = ctx.modelRegistry.find(QUERY_PROVIDER, QUERY_MODEL) ?? ctx.model;
    if (!model) {
      return errorResult("No model available to analyze the session.");
    }

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
            text: `## Session Conversation\n\n${conversationText}\n\n## Question\n\n${question}`,
          },
        ],
        timestamp: Date.now(),
      };

      const queryStream = stream(
        model,
        { systemPrompt: QUERY_SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers, signal },
      );

      let lastPartialAnswer = "";

      for await (const event of queryStream) {
        if (
          event.type !== "text_start" &&
          event.type !== "text_delta" &&
          event.type !== "text_end"
        ) {
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
            sessionPath,
            sessionUuid,
            question,
            messageCount: messages.length,
            answer: partialAnswer,
          } satisfies SessionQueryDetails,
        });
      }

      const response = await queryStream.result();
      const text = getAssistantText(response.content).trim();

      if (response.stopReason === "aborted") {
        return {
          content: [{ type: "text" as const, text: "Query was cancelled." }],
          details: {
            cancelled: true,
            sessionPath,
            sessionUuid,
            question,
            messageCount: messages.length,
            answer: "",
          },
        };
      }

      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || text || "Session query failed");
      }

      return {
        content: [{ type: "text" as const, text: text || "No answer returned." }],
        details: {
          sessionPath,
          sessionUuid,
          question,
          messageCount: messages.length,
          answer: text,
        } satisfies SessionQueryDetails,
      };
    } catch (err) {
      return errorResult(`Error querying session: ${err}`);
    }
  },
});
export default function (pi: ExtensionAPI) {
  pi.registerTool(sessionQueryTool);
}

function syncRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
): SessionQueryRenderState {
  const state = context.state as SessionQueryRenderState;

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  if (isPartial && state.startedAt !== undefined && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
    state.interval.unref?.();
  }

  if (!isPartial && state.startedAt !== undefined) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  return state;
}

function getElapsedMs(state: SessionQueryRenderState): number | undefined {
  return state.startedAt === undefined
    ? undefined
    : (state.endedAt ?? Date.now()) - state.startedAt;
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
  if (uuid.length >= 8) return uuid.slice(0, 8);
  return uuid;
}

function truncateQuestion(question: string, maxLength = 60): string {
  if (question.length <= maxLength) return question;
  return `${question.slice(0, maxLength - 1).trimEnd()}…`;
}

function setCallComponent(
  state: SessionQueryRenderState,
  lastComponent: unknown,
  text: string,
): Text {
  const component = createTextComponent(state.callComponent ?? lastComponent, text);
  state.callComponent = component;
  state.callText = text;
  return component;
}

function applyCollapsedSummaryToCall(state: SessionQueryRenderState, summary: string): void {
  if (!(state.callComponent instanceof Text) || !state.callText || !summary) {
    return;
  }

  state.callComponent.setText(`${state.callText}${summary}`);
}

function countRenderedLines(text: string): number {
  if (!text) {
    return 0;
  }

  return text.split("\n").filter((line) => line.length > 0).length;
}
