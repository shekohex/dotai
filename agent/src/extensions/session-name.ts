import { completeSimple } from "@earendil-works/pi-ai";
import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RENAME_INTERVAL = 15;
const MAX_TOKENS = 50;
const MAX_INPUT_CHARS = 500;
const RECENT_USER_MESSAGE_COUNT = 4;

const PRIMARY_PROVIDER = "openai";
const PRIMARY_MODEL_ID = "gpt-5.4-mini";
const PRIMARY_REASONING: ThinkingLevel = "medium";

const FALLBACK_PROVIDER = "opencode-go";
const FALLBACK_MODEL_ID = "deepseek-v4-flash";
const FALLBACK_REASONING: ThinkingLevel = "low";

export default function (pi: ExtensionAPI) {
  let messageCount = 0;
  let pending = false;

  pi.on("input", (event, ctx) => {
    const text = event.text.trim();
    if (text.startsWith("/") || text.length < 10) return;

    messageCount++;

    const isFirst = messageCount === 1;
    const isInterval = messageCount > 1 && (messageCount - 1) % RENAME_INTERVAL === 0;
    if (!isFirst && !isInterval) return;
    if (pending) return;

    const currentName = pi.getSessionName() ?? undefined;
    pending = true;

    generateAndSetName(ctx, text, currentName, isFirst)
      .then((name) => {
        if (name !== null && name.length > 0) pi.setSessionName(name);
      })
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  });

  pi.on("session_start", (_event) => {
    messageCount = 0;
    pending = false;
  });
}

export function extractUserText(
  content: string | { type: string; text?: string }[],
): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return (
    content
      .filter((c): c is { type: string; text: string } => c.type === "text" && c.text !== undefined)
      .map((c) => c.text)
      .join(" ")
      .trim() || undefined
  );
}

export function getRecentUserMessages(ctx: ExtensionContext, currentText: string): string[] {
  const entries = ctx.sessionManager.getEntries();
  const previousMessages: string[] = [];

  for (
    let i = entries.length - 1;
    i >= 0 && previousMessages.length < RECENT_USER_MESSAGE_COUNT - 1;
    i--
  ) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user") continue;

    const text = extractUserText(entry.message.content);
    if (text !== undefined) previousMessages.unshift(text);
  }

  previousMessages.push(currentText);
  return previousMessages;
}

const SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

Generate a brief title that would help the user find this conversation later.

Follow all rules below.
Your output must be:
- A single line
- No explanations
- Must be in title case for that language

Rules:
- Use the same language as the user message being summarized
- Title must be grammatically correct and read naturally
- Never include tool names in the title
- Focus on main topic or question the user needs to retrieve
- Vary phrasing - avoid repetitive patterns
- When file is mentioned, focus on WHAT the user wants WITH it
- Keep exact: technical terms, numbers, filenames, HTTP codes, ACRNOMs
- Remove: the, this, my, a, an
- Never assume tech stack
- NEVER respond to questions, just generate a title
- Title should NEVER include "summarizing" or "generating"
- Always output something meaningful, even if input is minimal
- If message is short or conversational, create a title reflecting tone or intent
- If title changes, follow the same rules.

Examples:
"debug 500 errors in production" -> "Debugging production 500 errors"
"refactor user service" -> "Refactoring user service"
"why is app.js failing" -> "app.js failure investigation"
"implement rate limiting" -> "Rate limiting implementation"
"how do I connect postgres to my API" -> "Postgres api connection"
"best practices for React hooks" -> "React hooks best practices"`;

async function generateAndSetName(
  ctx: ExtensionContext,
  userMessage: string,
  currentName: string | undefined,
  isFirst: boolean,
): Promise<string | null> {
  const modelAuth = await resolveNameModel(ctx);
  if (!modelAuth) return null;

  const recentMessages = getRecentUserMessages(ctx, userMessage);
  const truncated = recentMessages.map((m) =>
    m.length > MAX_INPUT_CHARS ? m.slice(0, MAX_INPUT_CHARS) + "..." : m,
  );

  const messages: Message[] = [];

  if (isFirst) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text" as const,
          text: "Generate the title based on the following message:",
        },
      ],
      timestamp: Date.now(),
    });
    messages.push({
      role: "user" as const,
      content: [{ type: "text" as const, text: userMessage.slice(0, MAX_INPUT_CHARS) }],
      timestamp: Date.now(),
    });
  } else {
    messages.push({
      role: "user",
      content: [
        {
          type: "text" as const,
          text: "Here is a list of Recent Messages, please generate the title based on them:",
        },
      ],
      timestamp: Date.now(),
    });
    for (const msg of truncated) {
      messages.push({
        role: "user" as const,
        content: [{ type: "text" as const, text: msg }],
        timestamp: Date.now(),
      });
    }
    messages.push({
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `Current title: ${currentName}. Decide: does title still fit? If topic shifted, output new title. If it fits, output EXACT current title.`,
        },
      ],
      timestamp: Date.now(),
    });
  }

  const response = await completeSimple(
    modelAuth.model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages,
    },
    {
      apiKey: modelAuth.apiKey,
      headers: modelAuth.headers,
      reasoning: modelAuth.reasoning,
      maxTokens: MAX_TOKENS,
      signal: ctx.signal,
    },
  );

  if (response.stopReason === "aborted") return null;

  const title = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  return title ?? null;
}

async function resolveNameModel(ctx: ExtensionContext): Promise<
  | {
      model: Model<Api>;
      apiKey: string;
      headers?: Record<string, string>;
      reasoning: ThinkingLevel;
    }
  | undefined
> {
  const primary = ctx.modelRegistry.find(PRIMARY_PROVIDER, PRIMARY_MODEL_ID);

  if (primary) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(primary);
    if (auth.ok && auth.apiKey !== undefined && auth.apiKey.length > 0) {
      return {
        model: primary,
        apiKey: auth.apiKey,
        headers: auth.headers,
        reasoning: PRIMARY_REASONING,
      };
    }
  }

  const fallback = ctx.modelRegistry.find(FALLBACK_PROVIDER, FALLBACK_MODEL_ID);
  if (!fallback) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(fallback);
  if (!auth.ok || auth.apiKey === undefined || auth.apiKey.length === 0) return undefined;

  return {
    model: fallback,
    apiKey: auth.apiKey,
    headers: auth.headers,
    reasoning: FALLBACK_REASONING,
  };
}
