import type { Api, Model } from "@earendil-works/pi-ai";
import { getEncoding } from "js-tiktoken";
import type { ResponseItem } from "./openai-remote-types.js";

export const REMOTE_COMPACTION_TRUNCATED_TOOL_OUTPUT =
  "Output exceeded the available model context and was truncated";
export const OPENAI_CODEX_COMPACTION_ENDPOINT_BUDGET_TOKENS = 372_000;
const EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

export type RemoteCompactionRequestContext = {
  instructions?: string;
  input: ResponseItem[];
};

type TokenEncoder = { encode(value: string): ArrayLike<unknown> };
const tokenEncoder = getEncoding("o200k_base");

function estimateTokenCount(value: unknown, encoding: TokenEncoder): number {
  const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  try {
    return encoding.encode(serialized).length;
  } catch {
    return Math.ceil(serialized.length / 2);
  }
}

function rewriteToolOutputItem(item: ResponseItem): {
  recognized: boolean;
  item: ResponseItem;
} {
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    if (item.output === REMOTE_COMPACTION_TRUNCATED_TOOL_OUTPUT) {
      return { recognized: true, item };
    }
    return {
      recognized: true,
      item: { ...item, output: REMOTE_COMPACTION_TRUNCATED_TOOL_OUTPUT },
    };
  }
  if (item.type === "tool_search_output") {
    if (Array.isArray(item.tools) && item.tools.length === 0) {
      return { recognized: true, item };
    }
    return { recognized: true, item: { ...item, tools: [] } };
  }
  return { recognized: false, item };
}

export function resolveRemoteCompactionRequestBudget(model: Model<Api>): number | undefined {
  const modelId = model.id.includes("/") ? (model.id.split("/").pop() ?? model.id) : model.id;
  if (
    model.provider === "openai-codex" &&
    /^gpt-5\.6-(?:luna|terra|sol)$/u.test(modelId.toLowerCase())
  ) {
    return OPENAI_CODEX_COMPACTION_ENDPOINT_BUDGET_TOKENS;
  }
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return undefined;
  return Math.floor((model.contextWindow * EFFECTIVE_CONTEXT_WINDOW_PERCENT) / 100);
}

export function shrinkRemoteCompactionRequestForEndpoint(
  request: RemoteCompactionRequestContext,
  options: { budgetTokens?: number; tokensBefore: number },
): { request: RemoteCompactionRequestContext; rewrittenOutputs: number } {
  const budgetTokens = options.budgetTokens;
  if (
    budgetTokens === undefined ||
    !Number.isFinite(budgetTokens) ||
    budgetTokens <= 0 ||
    !Number.isFinite(options.tokensBefore) ||
    options.tokensBefore <= budgetTokens
  ) {
    return { request, rewrittenOutputs: 0 };
  }

  const estimatedTokensBefore =
    estimateTokenCount(request.instructions ?? "", tokenEncoder) +
    estimateTokenCount(request.input, tokenEncoder);
  if (estimatedTokensBefore <= budgetTokens) {
    return { request, rewrittenOutputs: 0 };
  }

  let rewrittenOutputs = 0;
  let estimatedTokensAfter = estimatedTokensBefore;
  let input: ResponseItem[] | undefined;
  for (
    let index = request.input.length - 1;
    index >= 0 && estimatedTokensAfter > budgetTokens;
    index--
  ) {
    const item = (input ?? request.input)[index];
    if (item === undefined) break;
    const rewrite = rewriteToolOutputItem(item);
    if (!rewrite.recognized) break;
    if (rewrite.item === item) continue;

    input ??= [...request.input];
    input[index] = rewrite.item;
    rewrittenOutputs++;
    estimatedTokensAfter +=
      estimateTokenCount(rewrite.item, tokenEncoder) - estimateTokenCount(item, tokenEncoder);
  }

  return {
    request: input === undefined ? request : { ...request, input },
    rewrittenOutputs,
  };
}
