import { stream, type Api, type Message, type Model } from "@mariozechner/pi-ai";
import {
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  CONTEXT_TRANSFER_MODEL,
  CONTEXT_TRANSFER_PROVIDER,
} from "./session-launch-utils.constants.js";

type SessionModel = NonNullable<ExtensionContext["model"]>;

export type SummaryGenerationConfig = {
  model: SessionModel;
  apiKey: string;
  headers?: Record<string, string>;
  warning?: string;
};

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

export async function getSummaryGenerationConfig(
  ctx: ExtensionContext,
): Promise<{ config?: SummaryGenerationConfig; error?: string }> {
  if (!ctx.model) {
    return { error: "No model selected" };
  }

  const preferredModel = ctx.modelRegistry.find(CONTEXT_TRANSFER_PROVIDER, CONTEXT_TRANSFER_MODEL);
  const generationModel = preferredModel ?? (isApiModel(ctx.model) ? ctx.model : undefined);
  if (generationModel === undefined) {
    return { error: "No compatible model selected" };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(generationModel);
  if (!auth.ok) {
    return { error: `Handoff auth failed: ${auth.error}` };
  }
  if (auth.apiKey === undefined || auth.apiKey.length === 0) {
    return { error: `No API key for ${generationModel.provider}/${generationModel.id}` };
  }

  return {
    config: {
      model: generationModel,
      apiKey: auth.apiKey,
      headers: auth.headers,
      warning: preferredModel
        ? undefined
        : `Could not find ${CONTEXT_TRANSFER_PROVIDER}/${CONTEXT_TRANSFER_MODEL}; using current session model.`,
    },
  };
}

export function buildSummaryUserMessage(
  messages: Parameters<typeof convertToLlm>[0],
  goal: string,
): Message {
  const conversationText = serializeConversation(convertToLlm(messages));
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
      },
    ],
    timestamp: Date.now(),
  };
}

export async function streamSummaryUpdates(
  summaryStream: ReturnType<typeof stream>,
  onUpdate?: (summary: string) => void,
): Promise<void> {
  let lastPartialSummary = "";
  for await (const event of summaryStream) {
    if (event.type !== "text_start" && event.type !== "text_delta" && event.type !== "text_end") {
      continue;
    }

    const partialSummary = getAssistantText(event.partial.content).trim();
    if (!partialSummary || partialSummary === lastPartialSummary) {
      continue;
    }

    lastPartialSummary = partialSummary;
    onUpdate?.(partialSummary);
  }
}

export function collectSummaryText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
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
