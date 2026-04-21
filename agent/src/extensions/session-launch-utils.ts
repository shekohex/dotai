import { stream } from "@mariozechner/pi-ai";
import {
  BorderedLoader,
  type ExtensionContext,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";

import { resolveModeSpec, type ThinkingLevel } from "../mode-utils.js";
import { CONTEXT_TRANSFER_SYSTEM_PROMPT } from "./session-launch-utils.constants.js";
import {
  buildSummaryUserMessage,
  collectSummaryText,
  getSummaryGenerationConfig,
  streamSummaryUpdates,
} from "./session-launch-summary-helpers.js";
import { hasRuntimePrimitive } from "./runtime-capabilities.js";

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

export type SummaryGenerationResult = {
  summary?: string;
  warning?: string;
  error?: string;
  aborted?: boolean;
};

export type SummaryGenerationUpdate = {
  summary: string;
};

export function extractMessageText(
  content: string | Array<{ type: string; text?: string }>,
): string {
  if (typeof content === "string") {
    return content.trim();
  }

  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
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

export function parseModelOverride(
  value: string,
): { provider: string; modelId: string } | undefined {
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
  const modeSelection = await resolveModeLaunchSelection(ctx, options.mode);
  if (modeSelection.error !== undefined) {
    return { error: modeSelection.error };
  }
  const modelSelection = resolveModelLaunchSelection(ctx, options.model);
  if (modelSelection.error !== undefined) {
    return { error: modelSelection.error };
  }

  const targetModel = modelSelection.targetModel ?? modeSelection.targetModel;
  const thinkingLevel = modeSelection.thinkingLevel;

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

async function resolveModeLaunchSelection(
  ctx: ExtensionContext,
  mode: string | undefined,
): Promise<{ targetModel?: SessionModel; thinkingLevel?: ThinkingLevel; error?: string }> {
  if (mode === undefined || mode.length === 0) {
    return {};
  }

  const modeSpec = await resolveModeSpec(ctx.cwd, mode);
  if (!modeSpec) {
    return { error: `Unknown mode "${mode}"` };
  }

  const provider = modeSpec.provider;
  const modelId = modeSpec.modelId;
  if (
    provider === undefined ||
    provider.length === 0 ||
    modelId === undefined ||
    modelId.length === 0
  ) {
    return { thinkingLevel: modeSpec.thinkingLevel };
  }

  const targetModel = ctx.modelRegistry.find(provider, modelId);
  if (!targetModel) {
    return {
      error: `Mode "${mode}" references unknown model ${provider}/${modelId}`,
    };
  }

  return { targetModel, thinkingLevel: modeSpec.thinkingLevel };
}

function resolveModelLaunchSelection(
  ctx: ExtensionContext,
  modelOverride: string | undefined,
): { targetModel?: SessionModel; error?: string } {
  if (modelOverride === undefined || modelOverride.length === 0) {
    return {};
  }

  const parsedModel = parseModelOverride(modelOverride);
  if (!parsedModel) {
    return { error: `Invalid model override "${modelOverride}". Expected provider/modelId.` };
  }

  const targetModel = ctx.modelRegistry.find(parsedModel.provider, parsedModel.modelId);
  if (!targetModel) {
    return { error: `Unknown model ${modelOverride}` };
  }

  return { targetModel };
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

  const userMessage = buildSummaryUserMessage(messages, goal);

  try {
    const summaryStream = stream(
      generation.config.model,
      { systemPrompt: CONTEXT_TRANSFER_SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: generation.config.apiKey, headers: generation.config.headers, signal },
    );

    await streamSummaryUpdates(summaryStream, (summary) => {
      onUpdate?.({ summary });
    });

    const response = await summaryStream.result();

    if (response.stopReason === "aborted") {
      return { aborted: true };
    }

    if (response.stopReason === "error") {
      return { error: response.errorMessage ?? "Handoff generation failed" };
    }

    return {
      summary: collectSummaryText(response.content),
      warning: generation.config.warning,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function generateContextTransferSummaryWithLoader(
  ctx: ExtensionContext,
  goal: string,
  messages: ReturnType<typeof getConversationMessages>,
  loaderTitle = "Generating handoff prompt...",
): Promise<SummaryGenerationResult> {
  if (!ctx.hasUI || !hasRuntimePrimitive(ctx, "custom")) {
    return generateContextTransferSummary(ctx, goal, messages);
  }

  return ctx.ui.custom<SummaryGenerationResult>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, loaderTitle);
    loader.onAbort = () => {
      done({ aborted: true });
    };

    generateContextTransferSummary(ctx, goal, messages, loader.signal)
      .then(done)
      .catch((error) => {
        done({ error: error instanceof Error ? error.message : String(error) });
      });

    return loader;
  });
}

export function buildContextTransferPrompt(summary: string, parentSession?: string): string {
  if (parentSession === undefined || parentSession.length === 0) {
    return summary.trim();
  }

  return `${summary.trim()}\n\n## Parent Session\nParent session: ${parentSession}\nIf you need additional detail from the parent session, use \`session_query\` with \`sessionPath\` set to the path above and a focused \`question\`.`;
}
