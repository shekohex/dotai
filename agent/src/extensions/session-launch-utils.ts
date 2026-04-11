import { stream, type Message } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";

import { resolveModeSpec, type ThinkingLevel } from "../mode-utils.js";

export type SessionModel = NonNullable<ExtensionContext["model"]>;

export type SessionLaunchOptions = {
  mode?: string;
  model?: string;
};

export type ResolvedSessionLaunchOptions = {
  mode?: string;
  model?: string;
  targetModel?: SessionModel;
  thinkingLevel?: ThinkingLevel;
};

type SummaryGenerationConfig = {
  model: SessionModel;
  apiKey: string;
  headers?: Record<string, string>;
  warning?: string;
};

export type SummaryGenerationResult = {
  summary?: string;
  warning?: string;
  error?: string;
  aborted?: boolean;
};

export type SummaryGenerationUpdate = {
  summary: string;
};

const CONTEXT_TRANSFER_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

const CONTEXT_TRANSFER_PROVIDER = "gemini" as const;
const CONTEXT_TRANSFER_MODEL = "gemini-3.1-flash-lite-preview" as const;

export function extractMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content.trim();
  }

  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function getConversationMessages(ctx: ExtensionContext) {
  return ctx.sessionManager
    .getBranch()
    .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
    .map((entry) => entry.message);
}

export function parseModelOverride(value: string): { provider: string; modelId: string } | undefined {
  const separatorIndex = value.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return undefined;
  }

  return {
    provider: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1),
  };
}

export async function resolveSessionLaunchOptions(
  ctx: ExtensionContext,
  options: SessionLaunchOptions,
): Promise<{ overrides?: ResolvedSessionLaunchOptions; error?: string }> {
  let targetModel: SessionModel | undefined;
  let thinkingLevel: ThinkingLevel | undefined;

  if (options.mode) {
    const modeSpec = await resolveModeSpec(ctx.cwd, options.mode);
    if (!modeSpec) {
      return { error: `Unknown mode "${options.mode}"` };
    }

    if (modeSpec.provider && modeSpec.modelId) {
      const modeModel = ctx.modelRegistry.find(modeSpec.provider, modeSpec.modelId);
      if (!modeModel) {
        return { error: `Mode "${options.mode}" references unknown model ${modeSpec.provider}/${modeSpec.modelId}` };
      }
      targetModel = modeModel;
    }

    thinkingLevel = modeSpec.thinkingLevel;
  }

  if (options.model) {
    const parsedModel = parseModelOverride(options.model);
    if (!parsedModel) {
      return { error: `Invalid model override "${options.model}". Expected provider/modelId.` };
    }

    const model = ctx.modelRegistry.find(parsedModel.provider, parsedModel.modelId);
    if (!model) {
      return { error: `Unknown model ${options.model}` };
    }

    targetModel = model;
  }

  if (!targetModel && !thinkingLevel) {
    return {};
  }

  return {
    overrides: {
      mode: options.mode,
      model: options.model,
      targetModel,
      thinkingLevel,
    },
  };
}

async function getSummaryGenerationConfig(ctx: ExtensionContext): Promise<{ config?: SummaryGenerationConfig; error?: string }> {
  if (!ctx.model) {
    return { error: "No model selected" };
  }

  const preferredModel = ctx.modelRegistry.find(CONTEXT_TRANSFER_PROVIDER, CONTEXT_TRANSFER_MODEL);
  const generationModel = preferredModel ?? ctx.model;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(generationModel);
  if (!auth.ok) {
    return { error: `Handoff auth failed: ${auth.error}` };
  }

  if (!auth.apiKey) {
    return { error: `No API key for ${generationModel.provider}/${generationModel.id}` };
  }

  return {
    config: {
      model: generationModel,
      apiKey: auth.apiKey,
      headers: auth.headers,
      warning: preferredModel ? undefined : `Could not find ${CONTEXT_TRANSFER_PROVIDER}/${CONTEXT_TRANSFER_MODEL}; using current session model.`,
    },
  };
}

export async function generateContextTransferSummary(
  ctx: ExtensionContext,
  goal: string,
  messages: ReturnType<typeof getConversationMessages>,
  signal?: AbortSignal,
  onUpdate?: (update: SummaryGenerationUpdate) => void,
): Promise<SummaryGenerationResult> {
  const generation = await getSummaryGenerationConfig(ctx);
  if (!generation.config) {
    return { error: generation.error };
  }

  const conversationText = serializeConversation(convertToLlm(messages));
  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
      },
    ],
    timestamp: Date.now(),
  };

  try {
    const summaryStream = stream(
      generation.config.model,
      { systemPrompt: CONTEXT_TRANSFER_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: generation.config.apiKey, headers: generation.config.headers, signal },
    );

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
      onUpdate?.({ summary: partialSummary });
    }

    const response = await summaryStream.result();

    if (response.stopReason === "aborted") {
      return { aborted: true };
    }

    if (response.stopReason === "error") {
      return { error: response.errorMessage || "Handoff generation failed" };
    }

    return {
      summary: response.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim(),
      warning: generation.config.warning,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function generateContextTransferSummaryWithLoader(
  ctx: ExtensionContext,
  goal: string,
  messages: ReturnType<typeof getConversationMessages>,
  loaderTitle = "Generating handoff prompt...",
): Promise<SummaryGenerationResult> {
  if (!ctx.hasUI) {
    return generateContextTransferSummary(ctx, goal, messages);
  }

  return ctx.ui.custom<SummaryGenerationResult>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, loaderTitle);
    loader.onAbort = () => done({ aborted: true });

    generateContextTransferSummary(ctx, goal, messages, loader.signal)
      .then(done)
      .catch((error) => {
        done({ error: error instanceof Error ? error.message : String(error) });
      });

    return loader;
  });
}

function getAssistantText(content: Array<{ type: string; text?: string } | { type: string; thinking?: string }>): string {
  return content
    .flatMap((item) => (item.type === "text" && "text" in item && typeof item.text === "string" ? [item.text] : []))
    .join("\n");
}

export function buildContextTransferPrompt(summary: string, parentSession?: string): string {
  if (!parentSession) {
    return summary.trim();
  }

  return `${summary.trim()}\n\n## Parent Session\nParent session: ${parentSession}\nIf you need additional detail from the parent session, use \`session_query\` with \`sessionPath\` set to the path above and a focused \`question\`.`;
}
