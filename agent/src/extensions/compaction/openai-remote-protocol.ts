import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../utils/error-message.js";
import { providerHeadersToRecord } from "../../utils/provider-headers.js";
import { asRecord, readNumber, readString } from "../../utils/unknown-data.js";
import { buildRemoteCompactionHistory } from "./openai-remote-messages.js";
import {
  resolveRemoteCompactionRequestBudget,
  shrinkRemoteCompactionRequestForEndpoint,
} from "./openai-remote-request-shrink.js";
import type {
  RemoteCompactionResult,
  ResponseItem,
  ResponsesReasoningConfig,
  ResponsesTextConfig,
} from "./openai-remote-types.js";

const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const REMOTE_COMPACTION_MAX_RETRIES = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CodexTokenPayloadSchema = Type.Object(
  {
    "https://api.openai.com/auth": Type.Object(
      { chatgpt_account_id: Type.String() },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

const RemoteCompactionEventSchema = Type.Object(
  {
    type: Type.String(),
    message: Type.Optional(Type.String()),
    item: Type.Optional(Type.Unknown()),
    response: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

const CompactionItemSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("compaction"), Type.Literal("compaction_summary")]),
    id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    encrypted_content: Type.String({ minLength: 1 }),
    internal_chat_message_metadata_passthrough: Type.Optional(
      Type.Union([
        Type.Object(
          { turn_id: Type.Optional(Type.Union([Type.String(), Type.Null()])) },
          { additionalProperties: true },
        ),
        Type.Null(),
      ]),
    ),
  },
  { additionalProperties: true },
);

function canonicalCompactionItem(value: unknown): ResponseItem | undefined {
  if (!Value.Check(CompactionItemSchema, value)) return undefined;
  const item = Value.Parse(CompactionItemSchema, value);
  if (item.encrypted_content.trim().length === 0) return undefined;
  const metadata = item.internal_chat_message_metadata_passthrough;
  return {
    type: "compaction",
    ...(typeof item.id === "string" ? { id: item.id } : {}),
    encrypted_content: item.encrypted_content,
    ...(metadata !== null && metadata !== undefined
      ? {
          internal_chat_message_metadata_passthrough:
            typeof metadata.turn_id === "string" ? { turn_id: metadata.turn_id } : {},
        }
      : {}),
  };
}

export function supportsOpenAIRemoteCompaction(model: Model<Api> | undefined): model is Model<Api> {
  if (model === undefined) return false;
  if (model.provider === "codex-openai") return model.api === "openai-responses";
  return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function remoteCompactionModelKey(model: Model<Api>): string {
  const fallbackBaseUrl =
    model.provider === "openai-codex"
      ? "https://chatgpt.com/backend-api"
      : "https://api.openai.com/v1";
  return `${model.provider}:${model.api}:${model.id}:${normalizeBaseUrl(model.baseUrl, fallbackBaseUrl)}`;
}

function normalizeBaseUrl(baseUrl: string, fallback: string): string {
  const trimmed = baseUrl.trim();
  return (trimmed.length > 0 ? trimmed : fallback).replace(/\/+$/, "");
}

export function remoteCompactionEndpointUrl(model: Model<Api>): string {
  if (!supportsOpenAIRemoteCompaction(model)) {
    throw new Error("Remote compaction is not supported for this model.");
  }
  if (model.provider === "openai-codex") {
    const baseUrl = normalizeBaseUrl(model.baseUrl, "https://chatgpt.com/backend-api");
    if (baseUrl.endsWith("/codex/responses")) return baseUrl;
    if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
    return `${baseUrl}/codex/responses`;
  }

  const baseUrl = normalizeBaseUrl(model.baseUrl, "https://api.openai.com/v1");
  if (baseUrl.endsWith("/responses")) return baseUrl;
  return baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".codex");
}

function resolveCodexInstallationId(): string {
  const path = join(resolveCodexHome(), "installation_id");
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (UUID_RE.test(existing)) return existing.toLowerCase();
    }
  } catch {
    // Match Codex behavior: regenerate invalid or unreadable installation ids.
  }

  const installationId = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, installationId);
  } catch {
    // Identity header is optional parity metadata, not a compaction prerequisite.
  }
  return installationId;
}

function buildCodexIdentityHeaders(sessionId?: string): Record<string, string> {
  const installationId = resolveCodexInstallationId();
  if (sessionId === undefined || sessionId.length === 0) {
    return { "x-codex-installation-id": installationId };
  }
  return {
    "x-codex-installation-id": installationId,
    "x-codex-window-id": `${sessionId}:0`,
    session_id: sessionId,
  };
}

function extractCodexAccountId(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) {
    throw new Error("Failed to extract accountId from Codex token");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse Codex token: ${errorMessage(error)}`, { cause: error });
  }
  if (!Value.Check(CodexTokenPayloadSchema, payload)) {
    throw new Error("Failed to extract accountId from Codex token");
  }
  return Value.Parse(CodexTokenPayloadSchema, payload)["https://api.openai.com/auth"]
    .chatgpt_account_id;
}

function withRemoteCompactionFeature(headers: Record<string, string>): Record<string, string> {
  const configuredFeatures = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "x-codex-beta-features")?.[1]
    ?.split(",")
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0);
  const headersWithoutFeature = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "x-codex-beta-features"),
  );
  const features = [...new Set([...(configuredFeatures ?? []), REMOTE_COMPACTION_FEATURE])];
  return { ...headersWithoutFeature, "x-codex-beta-features": features.join(",") };
}

export function buildRemoteCompactionHeaders(params: {
  model: Model<Api>;
  apiKey: string;
  headers?: ProviderHeaders;
  sessionId?: string;
}): Record<string, string> {
  const commonHeaders = withRemoteCompactionFeature(
    providerHeadersToRecord({
      authorization: `Bearer ${params.apiKey}`,
      ...buildCodexIdentityHeaders(params.sessionId),
      ...params.headers,
      accept: "text/event-stream",
      "content-type": "application/json",
    }) ?? {},
  );
  if (params.model.provider === "codex-openai") return commonHeaders;
  if (params.model.provider !== "openai-codex") {
    throw new Error("Remote compaction headers are not supported for this model.");
  }
  return {
    ...commonHeaders,
    "chatgpt-account-id": extractCodexAccountId(params.apiKey),
    originator: "pi",
    "user-agent": `@shekohex/agent (${platform()} ${release()}; ${arch()})`,
    "OpenAI-Beta": "responses=experimental",
  };
}

export function buildRemoteCompactionTools(
  model: Model<Api>,
  allTools: ToolInfo[],
  activeToolNames: string[],
  providerTools: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
  const providerToolsByName = new Map<string, Record<string, unknown>>();
  const providerOnlyToolNames = new Set<string>();
  const providerOnlyTools: Record<string, unknown>[] = [];
  for (const tool of providerTools) {
    const name = readString(tool.name);
    if (name === undefined) {
      providerOnlyTools.push(promoteRemoteCompactionTool(tool));
    } else {
      providerToolsByName.set(name, tool);
      if (!toolsByName.has(name) && !providerOnlyToolNames.has(name)) {
        providerOnlyToolNames.add(name);
        providerOnlyTools.push(promoteRemoteCompactionTool(tool));
      }
    }
  }

  const activeTools = activeToolNames.flatMap((name): Record<string, unknown>[] => {
    const providerTool = providerToolsByName.get(name);
    if (providerTool !== undefined) return [promoteRemoteCompactionTool(providerTool)];
    const tool = toolsByName.get(name);
    if (tool === undefined) return [];
    const compat = asRecord(model.compat);
    return convertResponsesTools([tool], {
      strict: null,
      supportsStrictMode:
        typeof compat?.supportsStrictMode === "boolean" ? compat.supportsStrictMode : undefined,
      supportsOpenAIGrammarTools:
        typeof compat?.supportsOpenAIGrammarTools === "boolean"
          ? compat.supportsOpenAIGrammarTools
          : undefined,
    }).flatMap((convertedTool) => {
      const record = asRecord(convertedTool);
      return record === undefined ? [] : [structuredClone(record)];
    });
  });
  return [...activeTools, ...providerOnlyTools];
}

function promoteRemoteCompactionTool(tool: Record<string, unknown>): Record<string, unknown> {
  const promoted = structuredClone(tool);
  delete promoted.defer_loading;
  return promoted;
}

export function buildRemoteCompactionRequestBody(params: {
  model: Model<Api>;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  serviceTier?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const promptCacheKey =
    params.sessionId === undefined
      ? undefined
      : Array.from(params.sessionId).slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
  return {
    model: params.model.id,
    input: [...params.input, { type: "compaction_trigger" }],
    instructions: params.instructions,
    tools: params.tools,
    parallel_tool_calls: true,
    tool_choice: "auto",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(promptCacheKey === undefined ? {} : { prompt_cache_key: promptCacheKey }),
    ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
    ...(params.text === undefined ? {} : { text: params.text }),
    ...(params.serviceTier === undefined ? {} : { service_tier: params.serviceTier }),
  };
}

function parseSseData(text: string): unknown[] {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .flatMap((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (data.length === 0 || data === "[DONE]") return [];
      try {
        return [JSON.parse(data) as unknown];
      } catch {
        return [];
      }
    });
}

function remoteFailureMessage(response: unknown): string {
  const responseRecord = asRecord(response);
  const errorRecord = asRecord(responseRecord?.error);
  return readString(errorRecord?.message) ?? "Response failed";
}

export function parseRemoteCompactionEvents(events: unknown[]): {
  compactionItem: ResponseItem;
  responseId: string;
  usage?: unknown;
} {
  let completed = false;
  let responseId: string | undefined;
  let usage: unknown;
  const compactionItems: ResponseItem[] = [];

  for (const value of events) {
    if (!Value.Check(RemoteCompactionEventSchema, value)) continue;
    const event = Value.Parse(RemoteCompactionEventSchema, value);
    if (event.type === "error") {
      throw new Error(`OpenAI remote compaction failed: ${event.message ?? "Unknown error"}`);
    }
    if (event.type === "response.failed") {
      throw new Error(`OpenAI remote compaction failed: ${remoteFailureMessage(event.response)}`);
    }
    if (event.type === "response.output_item.done") {
      const compactionItem = canonicalCompactionItem(event.item);
      if (compactionItem === undefined) continue;
      compactionItems.push(compactionItem);
      continue;
    }
    if (event.type === "response.completed") {
      completed = true;
      const response = asRecord(event.response);
      responseId = readString(response?.id);
      usage = response?.usage;
    }
  }

  if (!completed) {
    throw new Error("OpenAI remote compaction stream ended before response.completed.");
  }
  if (responseId === undefined) {
    throw new Error("OpenAI remote compaction response.completed did not include a response id.");
  }
  if (compactionItems.length !== 1 || compactionItems[0] === undefined) {
    throw new Error(
      `OpenAI remote compaction expected exactly one compaction item, got ${compactionItems.length}.`,
    );
  }
  return { compactionItem: compactionItems[0], responseId, usage };
}

function extractCacheWriteTokens(value: unknown): number {
  const record = asRecord(value);
  return readNumber(record?.cache_creation_tokens) ?? readNumber(record?.cache_write_tokens) ?? 0;
}

function extractRemoteCompactionUsage(model: Model<Api>, value: unknown): Usage | undefined {
  const usageRecord = asRecord(value);
  if (usageRecord === undefined) return undefined;
  const inputTokens = readNumber(usageRecord.input_tokens) ?? 0;
  const outputTokens = readNumber(usageRecord.output_tokens) ?? 0;
  const details = asRecord(usageRecord.input_tokens_details);
  const cachedTokens = readNumber(details?.cached_tokens) ?? 0;
  const cacheWriteTokens = extractCacheWriteTokens(details);
  const usage: Usage = {
    input: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: readNumber(usageRecord.total_tokens) ?? inputTokens + outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

export async function callRemoteCompactionEndpoint(params: {
  model: Model<Api>;
  apiKey: string;
  headers?: ProviderHeaders;
  sessionId?: string;
  tokensBefore: number;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  serviceTier?: string;
  retryDelayMs?: number;
  signal?: AbortSignal;
}): Promise<RemoteCompactionResult> {
  if (!supportsOpenAIRemoteCompaction(params.model)) {
    throw new Error("Remote compaction only supports codex-openai and openai-codex.");
  }

  const shrinkResult = shrinkRemoteCompactionRequestForEndpoint(
    { input: params.input, instructions: params.instructions },
    {
      budgetTokens: resolveRemoteCompactionRequestBudget(params.model),
      tokensBefore: params.tokensBefore,
    },
  );
  const input = shrinkResult.request.input;

  const response = await fetchRemoteCompactionWithRetries({ ...params, input });

  const parsed = parseRemoteCompactionEvents(parseSseData(await response.text()));
  return {
    output: buildRemoteCompactionHistory(input, parsed.compactionItem),
    compactResponseId: parsed.responseId,
    createdAt: new Date().toISOString(),
    usage: extractRemoteCompactionUsage(params.model, parsed.usage),
  };
}

function shouldRetryRemoteCompaction(status: number | undefined, message: string): boolean {
  if (status === 429) return false;
  if (
    /\b(?:400|401|403)\b|unauthori[sz]ed|forbidden|usage limit|quota|not included|invalid request|context window|unsupported parameter/iu.test(
      message,
    )
  ) {
    return false;
  }
  return status === undefined || status >= 500;
}

async function waitForRemoteCompactionRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException("This operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

async function fetchRemoteCompactionWithRetries(
  params: Parameters<typeof callRemoteCompactionEndpoint>[0] & { input: ResponseItem[] },
): Promise<Response> {
  const delayMs = Math.max(0, params.retryDelayMs ?? 500);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= REMOTE_COMPACTION_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(remoteCompactionEndpointUrl(params.model), {
        method: "POST",
        headers: buildRemoteCompactionHeaders(params),
        body: JSON.stringify(buildRemoteCompactionRequestBody(params)),
        signal: params.signal,
      });
      if (response.ok) return response;
      const responseText = await response.text().catch(() => "");
      const message = `OpenAI remote compaction failed (${response.status}): ${responseText || response.statusText}`;
      if (
        attempt >= REMOTE_COMPACTION_MAX_RETRIES ||
        !shouldRetryRemoteCompaction(response.status, message)
      ) {
        throw new Error(message);
      }
      await waitForRemoteCompactionRetry(delayMs * 2 ** attempt, params.signal);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (params.signal?.aborted === true || failure.name === "AbortError") throw failure;
      if (
        attempt >= REMOTE_COMPACTION_MAX_RETRIES ||
        !shouldRetryRemoteCompaction(undefined, failure.message)
      ) {
        throw failure;
      }
      lastError = failure;
      await waitForRemoteCompactionRetry(delayMs * 2 ** attempt, params.signal);
    }
  }
  throw lastError ?? new Error("OpenAI remote compaction failed without a transport attempt.");
}
