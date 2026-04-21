import { parseUnknownRecord, readRecordField } from "./types.js";
import { parseNumericValue } from "./utils.js";

export function extractProviderModelAndUsage(obj: unknown): {
  provider?: unknown;
  model?: unknown;
  modelId?: unknown;
  usage?: unknown;
} {
  const root = parseUnknownRecord(obj);
  if (root === undefined) {
    return {};
  }

  const msg = readRecordField(root, "message");
  return {
    provider: root.provider ?? msg?.provider,
    model: root.model ?? msg?.model,
    modelId: root.modelId ?? msg?.modelId,
    usage: root.usage ?? msg?.usage,
  };
}

export function extractCostTotal(usage: unknown): number {
  const usageRecord = parseUnknownRecord(usage);
  if (usageRecord === undefined) return 0;

  const c = usageRecord.cost;
  if (typeof c === "number" || typeof c === "string") {
    return parseNumericValue(c);
  }

  const costRecord = parseUnknownRecord(c);
  const t = costRecord?.total;
  if (typeof t === "number" || typeof t === "string") {
    return parseNumericValue(t);
  }
  return 0;
}

export function extractTokensTotal(usage: unknown): number {
  const usageRecord = parseUnknownRecord(usage);
  if (usageRecord === undefined) return 0;

  let total = 0;
  total =
    parseNumericValue(usageRecord.totalTokens) ||
    parseNumericValue(usageRecord.total_tokens) ||
    parseNumericValue(usageRecord.tokens) ||
    parseNumericValue(usageRecord.tokenCount) ||
    parseNumericValue(usageRecord.token_count);
  if (total > 0) return total;

  const tokensRecord = parseUnknownRecord(usageRecord.tokens);
  total =
    parseNumericValue(tokensRecord?.total) ||
    parseNumericValue(tokensRecord?.totalTokens) ||
    parseNumericValue(tokensRecord?.total_tokens);
  if (total > 0) return total;

  const a =
    parseNumericValue(usageRecord.promptTokens) ||
    parseNumericValue(usageRecord.prompt_tokens) ||
    parseNumericValue(usageRecord.inputTokens) ||
    parseNumericValue(usageRecord.input_tokens);
  const b =
    parseNumericValue(usageRecord.completionTokens) ||
    parseNumericValue(usageRecord.completion_tokens) ||
    parseNumericValue(usageRecord.outputTokens) ||
    parseNumericValue(usageRecord.output_tokens);
  const sum = a + b;
  return Math.max(sum, 0);
}
