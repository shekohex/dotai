import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "../../utils/error-message.js";
import { asRecord, readNumber, readString } from "../../utils/unknown-data.js";
import { buildRemoteCompactionHistory } from "./openai-remote-messages.js";
import type {
  RemoteCompactionResult,
  ResponseItem,
  ResponsesReasoningConfig,
  ResponsesTextConfig,
} from "./openai-remote-types.js";

const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
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
  { type: Type.Literal("compaction") },
  { additionalProperties: true },
);

export function supportsOpenAIRemoteCompaction(model: Model<Api> | undefined): model is Model<Api> {
  if (model === undefined) return false;
  if (model.provider === "codex-openai") return model.api === "openai-responses";
  return model.provider === "openai-codex" && model.api === "openai-codex-responses";
}

export function remoteCompactionModelKey(model: Model<Api>): string {
  return `${model.provider}:${model.api}:${model.id}`;
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
  headers?: Record<string, string>;
  sessionId?: string;
}): Record<string, string> {
  const commonHeaders = withRemoteCompactionFeature({
    authorization: `Bearer ${params.apiKey}`,
    ...buildCodexIdentityHeaders(params.sessionId),
    ...params.headers,
    accept: "text/event-stream",
    "content-type": "application/json",
  });
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
  allTools: ToolInfo[],
  activeToolNames: string[],
): Record<string, unknown>[] {
  const activeTools = new Set(activeToolNames);
  return allTools
    .filter((tool) => activeTools.has(tool.name))
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
}

export function buildRemoteCompactionRequestBody(params: {
  model: Model<Api>;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  sessionId?: string;
}): Record<string, unknown> {
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
    ...(params.sessionId === undefined ? {} : { prompt_cache_key: params.sessionId }),
    ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
    ...(params.text === undefined ? {} : { text: params.text }),
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
  usage?: unknown;
} {
  let completed = false;
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
      if (!Value.Check(CompactionItemSchema, event.item)) continue;
      compactionItems.push(Value.Parse(CompactionItemSchema, event.item));
      continue;
    }
    if (event.type === "response.completed") {
      completed = true;
      usage = asRecord(event.response)?.usage;
    }
  }

  if (!completed) {
    throw new Error("OpenAI remote compaction stream ended before response.completed.");
  }
  if (compactionItems.length !== 1 || compactionItems[0] === undefined) {
    throw new Error(
      `OpenAI remote compaction expected exactly one compaction item, got ${compactionItems.length}.`,
    );
  }
  return { compactionItem: compactionItems[0], usage };
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
  headers?: Record<string, string>;
  sessionId?: string;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  signal?: AbortSignal;
}): Promise<RemoteCompactionResult> {
  if (!supportsOpenAIRemoteCompaction(params.model)) {
    throw new Error("Remote compaction only supports codex-openai and openai-codex.");
  }

  const response = await fetch(remoteCompactionEndpointUrl(params.model), {
    method: "POST",
    headers: buildRemoteCompactionHeaders(params),
    body: JSON.stringify(buildRemoteCompactionRequestBody(params)),
    signal: params.signal,
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    throw new Error(
      `OpenAI remote compaction failed (${response.status}): ${responseText || response.statusText}`,
    );
  }

  const parsed = parseRemoteCompactionEvents(parseSseData(await response.text()));
  return {
    output: buildRemoteCompactionHistory(params.input, parsed.compactionItem),
    usage: extractRemoteCompactionUsage(params.model, parsed.usage),
  };
}
