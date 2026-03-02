import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_USE_RESPONSE_SCHEMA = false;
const THINKING_BUDGET_DEEP = 1024;
const THINKING_BUDGET_FAST = 128;
const MAX_URLS = 10;
const RETRY_BACKOFF_MS = [1000, 3000, 5000, 8000];

type AuthInfo =
  | {
      type: "api";
      key: string;
    }
  | {
      type: "oauth";
      refresh: string;
      access: string;
      expires: number;
    }
  | {
      type: "wellknown";
      key: string;
      token: string;
    };

type AuthFile = Record<string, AuthInfo>;

type GroundingChunk = {
  web?: {
    uri?: string;
    title?: string;
  };
};

type GroundingSupport = {
  segment?: {
    startIndex?: number;
    endIndex?: number;
    text?: string;
  };
  groundingChunkIndices?: number[];
};

type GroundingMetadata = {
  webSearchQueries?: string[];
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
  searchEntryPoint?: {
    renderedContent?: string;
  };
};

type UrlMetadata = {
  retrieved_url?: string;
  url_retrieval_status?: string;
};

type UrlContextMetadata = {
  url_metadata?: UrlMetadata[];
};

type GeminiCandidate = {
  content?: {
    parts?: Array<{ text?: string }>;
    role?: string;
  };
  finishReason?: string;
  groundingMetadata?: GroundingMetadata;
  urlContextMetadata?: UrlContextMetadata;
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

type SearchResult = {
  text: string;
  sources: Array<{ title: string; url: string }>;
  searchQueries: string[];
  urlsRetrieved: Array<{ url: string; status: string }>;
};

type StructuredSearchResult = {
  answer?: string;
  sources?: Array<{ title?: string; url?: string }>;
  searchQueries?: string[];
  urlsRetrieved?: Array<{ url?: string; status?: string }>;
};

function getDataDir(): string {
  const platform = process.platform;

  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }

  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdgData, "opencode");
}

function getStoragePath(): string {
  return join(getDataDir(), "auth.json");
}

function createError(message: string, nextStep?: string, requestId?: string): string {
  const lines = [`Error: ${message}`];
  if (nextStep) lines.push(`Next: ${nextStep}`);
  if (requestId) lines.push(`Request ID: ${requestId}`);
  return lines.join("\n");
}

function normalizeBaseUrl(baseURL?: string): string {
  const raw = baseURL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  const normalized = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  new URL(normalized);
  return normalized;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function getStringAtPath(source: unknown, path: string[]): string | undefined {
  let current: unknown = source;
  for (const segment of path) {
    const record = toRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return typeof current === "string" ? current : undefined;
}

function getBooleanAtPath(source: unknown, path: string[]): boolean | undefined {
  let current: unknown = source;
  for (const segment of path) {
    const record = toRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  if (typeof current === "boolean") return current;
  if (typeof current === "string") {
    const normalized = current.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

const BASE_URL_CANDIDATES: Array<{ path: string[]; source: string }> = [
  { path: ["provider", "google", "options", "baseURL"], source: "provider.google.options.baseURL" },
  { path: ["provider", "google", "options", "baseUrl"], source: "provider.google.options.baseUrl" },
  { path: ["provider", "google", "api"], source: "provider.google.api" },
  { path: ["settings", "provider", "google", "options", "baseURL"], source: "settings.provider.google.options.baseURL" },
  { path: ["settings", "provider", "google", "options", "baseUrl"], source: "settings.provider.google.options.baseUrl" },
  { path: ["settings", "provider", "google", "api"], source: "settings.provider.google.api" },
  { path: ["data", "provider", "google", "options", "baseURL"], source: "data.provider.google.options.baseURL" },
  { path: ["data", "provider", "google", "options", "baseUrl"], source: "data.provider.google.options.baseUrl" },
  { path: ["data", "provider", "google", "api"], source: "data.provider.google.api" },
  { path: ["config", "provider", "google", "options", "baseURL"], source: "config.provider.google.options.baseURL" },
  { path: ["config", "provider", "google", "options", "baseUrl"], source: "config.provider.google.options.baseUrl" },
  { path: ["config", "provider", "google", "api"], source: "config.provider.google.api" },
  {
    path: ["config", "settings", "provider", "google", "options", "baseURL"],
    source: "config.settings.provider.google.options.baseURL",
  },
  {
    path: ["config", "settings", "provider", "google", "options", "baseUrl"],
    source: "config.settings.provider.google.options.baseUrl",
  },
  { path: ["config", "settings", "provider", "google", "api"], source: "config.settings.provider.google.api" },
];

const RESPONSE_SCHEMA_CANDIDATES: Array<{ path: string[]; source: string }> = [
  { path: ["provider", "google", "options", "googleSearchResponseSchema"], source: "provider.google.options.googleSearchResponseSchema" },
  { path: ["provider", "google", "options", "googleSearchJsonSchema"], source: "provider.google.options.googleSearchJsonSchema" },
  { path: ["provider", "google", "options", "useResponseSchema"], source: "provider.google.options.useResponseSchema" },
  { path: ["provider", "google", "options", "useJsonSchema"], source: "provider.google.options.useJsonSchema" },
  {
    path: ["settings", "provider", "google", "options", "googleSearchResponseSchema"],
    source: "settings.provider.google.options.googleSearchResponseSchema",
  },
  {
    path: ["settings", "provider", "google", "options", "googleSearchJsonSchema"],
    source: "settings.provider.google.options.googleSearchJsonSchema",
  },
  { path: ["settings", "provider", "google", "options", "useResponseSchema"], source: "settings.provider.google.options.useResponseSchema" },
  { path: ["settings", "provider", "google", "options", "useJsonSchema"], source: "settings.provider.google.options.useJsonSchema" },
  {
    path: ["data", "provider", "google", "options", "googleSearchResponseSchema"],
    source: "data.provider.google.options.googleSearchResponseSchema",
  },
  {
    path: ["data", "provider", "google", "options", "googleSearchJsonSchema"],
    source: "data.provider.google.options.googleSearchJsonSchema",
  },
  { path: ["data", "provider", "google", "options", "useResponseSchema"], source: "data.provider.google.options.useResponseSchema" },
  { path: ["data", "provider", "google", "options", "useJsonSchema"], source: "data.provider.google.options.useJsonSchema" },
  {
    path: ["config", "provider", "google", "options", "googleSearchResponseSchema"],
    source: "config.provider.google.options.googleSearchResponseSchema",
  },
  {
    path: ["config", "provider", "google", "options", "googleSearchJsonSchema"],
    source: "config.provider.google.options.googleSearchJsonSchema",
  },
  { path: ["config", "provider", "google", "options", "useResponseSchema"], source: "config.provider.google.options.useResponseSchema" },
  { path: ["config", "provider", "google", "options", "useJsonSchema"], source: "config.provider.google.options.useJsonSchema" },
  {
    path: ["config", "settings", "provider", "google", "options", "googleSearchResponseSchema"],
    source: "config.settings.provider.google.options.googleSearchResponseSchema",
  },
  {
    path: ["config", "settings", "provider", "google", "options", "googleSearchJsonSchema"],
    source: "config.settings.provider.google.options.googleSearchJsonSchema",
  },
  {
    path: ["config", "settings", "provider", "google", "options", "useResponseSchema"],
    source: "config.settings.provider.google.options.useResponseSchema",
  },
  { path: ["config", "settings", "provider", "google", "options", "useJsonSchema"], source: "config.settings.provider.google.options.useJsonSchema" },
];

function resolveConfiguredBaseUrl(source: unknown): { value: string; source: string } | undefined {
  for (const candidate of BASE_URL_CANDIDATES) {
    const value = getStringAtPath(source, candidate.path);
    if (value?.trim()) {
      return { value, source: candidate.source };
    }
  }
  return undefined;
}

function collectBaseUrlDebug(source: unknown): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const candidate of BASE_URL_CANDIDATES) {
    output[candidate.source] = getStringAtPath(source, candidate.path);
  }
  return output;
}

function resolveResponseSchemaMode(source: unknown): { value: boolean; source: string } | undefined {
  for (const candidate of RESPONSE_SCHEMA_CANDIDATES) {
    const value = getBooleanAtPath(source, candidate.path);
    if (typeof value === "boolean") {
      return { value, source: candidate.source };
    }
  }
  return undefined;
}

function buildSystemInstruction(thinking: boolean): string {
  const verbosity = thinking ? "High" : "Low";
  const plan = thinking
    ? "1. Plan: break the query into focused sub-questions."
    : "1. Plan: identify the single best search strategy.";
  const execute = thinking
    ? "2. Execute: search broadly, cross-check claims, and use multiple sources."
    : "2. Execute: search narrowly and use the strongest sources.";
  const validate = thinking
    ? "4. Validate: resolve conflicts or call them out explicitly."
    : "4. Validate: ensure the answer matches the query.";

  return [
    "<role>",
    "You are a super fast and smart Google Search research agent.",
    "You are precise, analytical, and persistent.",
    "</role>",
    "",
    "<instructions>",
    plan,
    execute,
    "3. Cite: every specific claim must include a source link; if none, say \"uncited\".",
    validate,
    "5. Format: return JSON that strictly matches the schema.",
    "</instructions>",
    "",
    "<constraints>",
    `- Verbosity: ${verbosity}`,
    "- Tone: Technical",
    "- No fabricated facts or URLs",
    "- Do not reveal planning, analysis, or tool-use reasoning",
    "- Output ONLY valid JSON matching the schema",
    "</constraints>",
    "",
    "<output_format>",
    "{",
    "  \"answer\": \"...\"",
    "  \"sources\": [{ \"title\": \"...\", \"url\": \"...\" }],",
    "  \"searchQueries\": [\"...\"],",
    "  \"urlsRetrieved\": [{ \"url\": \"...\", \"status\": \"...\" }]",
    "}",
    "</output_format>",
  ].join("\n");
}

function buildUserPrompt(query: string, urls: string[], thinking: boolean): string {
  const context = urls.length > 0 ? `URLs:\n${urls.join("\n")}` : "No additional context.";
  const finalInstruction = thinking
    ? "Use deeper reasoning internally, but output only the required format."
    : "Answer concisely and directly in the required format.";

  return [
    "<context>",
    context,
    "</context>",
    "",
    "<task>",
    `Please search the following: ${query}`,
    "</task>",
    "",
    "<final_instruction>",
    finalInstruction,
    "</final_instruction>",
  ].join("\n");
}

function parseSearchResponse(data: GeminiResponse): SearchResult {
  const result: SearchResult = {
    text: "",
    sources: [],
    searchQueries: [],
    urlsRetrieved: [],
  };

  if (!data.candidates || data.candidates.length === 0) {
    if (data.error?.message) {
      result.text = `Error: ${data.error.message}`;
    }
    return result;
  }

  const candidate = data.candidates[0];
  if (!candidate) return result;

  if (candidate.content?.parts) {
    result.text = candidate.content.parts
      .map((p) => p.text ?? "")
      .filter(Boolean)
      .join("\n");
  }

  const trimmed = result.text.trim();
  const jsonPayload = trimmed.startsWith("```")
    ? trimmed.replace(/^```\w*\n?|```$/g, "").trim()
    : trimmed;
  const match = /\{[\s\S]*\}/.exec(jsonPayload);
  const candidateJson = match ? match[0] : jsonPayload;
  if (candidateJson.startsWith("{") && candidateJson.endsWith("}")) {
    try {
      const structured = JSON.parse(candidateJson) as StructuredSearchResult;
      if (structured.answer) result.text = structured.answer;
      if (structured.sources?.length) {
        result.sources = structured.sources
          .filter((s) => s?.title && s?.url)
          .map((s) => ({ title: s.title as string, url: s.url as string }));
      }
      if (structured.searchQueries?.length) result.searchQueries = structured.searchQueries;
      if (structured.urlsRetrieved?.length) {
        result.urlsRetrieved = structured.urlsRetrieved
          .filter((u) => u?.url)
          .map((u) => ({ url: u.url as string, status: u.status ?? "UNKNOWN" }));
      }
    } catch {
      return result;
    }
  }

  const grounding = candidate.groundingMetadata;
  if (grounding?.webSearchQueries) {
    result.searchQueries = grounding.webSearchQueries;
  }

  if (grounding?.groundingChunks) {
    for (const chunk of grounding.groundingChunks) {
      if (chunk.web?.uri && chunk.web?.title) {
        result.sources.push({ title: chunk.web.title, url: chunk.web.uri });
      }
    }
  }

  const urlContext = candidate.urlContextMetadata;
  if (urlContext?.url_metadata) {
    for (const meta of urlContext.url_metadata) {
      if (meta.retrieved_url) {
        result.urlsRetrieved.push({
          url: meta.retrieved_url,
          status: meta.url_retrieval_status ?? "UNKNOWN",
        });
      }
    }
  }

  return result;
}

function formatSearchResult(result: SearchResult): string {
  const lines: string[] = [];
  lines.push("## Search Results", "");
  lines.push(result.text || "No content returned.", "");

  if (result.sources.length > 0) {
    lines.push("### Sources");
    for (const source of result.sources) {
      lines.push(`- [${source.title}](${source.url})`);
    }
    lines.push("");
  }

  if (result.urlsRetrieved.length > 0) {
    lines.push("### URLs Retrieved");
    for (const url of result.urlsRetrieved) {
      const status = url.status === "URL_RETRIEVAL_STATUS_SUCCESS" ? "OK" : url.status;
      lines.push(`- ${status} ${url.url}`);
    }
    lines.push("");
  }

  if (result.searchQueries.length > 0) {
    lines.push("### Search Queries Used");
    for (const q of result.searchQueries) {
      lines.push(`- \"${q}\"`);
    }
  }

  return lines.join("\n");
}

async function loadAuthFile(): Promise<AuthFile> {
  const storagePath = getStoragePath();
  const raw = await readFile(storagePath, "utf8");
  const parsed = JSON.parse(raw) as AuthFile;
  return parsed;
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(120000, Math.trunc(value)));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const GeminiTools: Plugin = async ({ client }) => {
  return {
    tool: {
      google_search: tool({
        description:
          "Search the web using Google Search with Gemini grounding. Returns real-time information from the internet with source citations.",
        args: {
          query: tool.schema.string().describe("The search query or question to answer using web search"),
          urls: tool.schema.array(tool.schema.string()).optional().describe("List of specific URLs to fetch and analyze"),
          thinking: tool.schema.boolean().optional().default(true).describe("Enable deeper reasoning (default: true)"),
          timeoutMs: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in milliseconds for the search request (default: 30000)"),
        },
        async execute(args, ctx) {
          const requestId = randomUUID();
          const query = args.query?.trim();
          if (!query) {
            return createError("query is empty", "Provide a non-empty query.", requestId);
          }

          const urls = (args.urls ?? []).map((u) => u.trim()).filter(Boolean).slice(0, MAX_URLS);
          for (const url of urls) {
            try {
              new URL(url);
            } catch {
              return createError(`invalid url \"${url}\" in urls`, "Provide valid absolute URLs.", requestId);
            }
          }

          let auth: AuthFile;
          try {
            auth = await loadAuthFile();
          } catch (error) {
            const storagePath = getStoragePath();
            const message = error instanceof Error ? error.message : String(error);
            return createError(
              `failed to read auth storage at ${storagePath}: ${message}`,
              "Run `opencode auth login` for provider `google`.",
              requestId,
            );
          }

          const googleAuth = auth.google;
          if (!googleAuth || googleAuth.type !== "api" || !googleAuth.key) {
            return createError(
              "not authenticated for provider \"google\"",
              "Run `opencode auth login` and authenticate the `google` provider.",
              requestId,
            );
          }

          let config: unknown;
          try {
            config = await client.config.get({ responseStyle: "data" });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createError(`failed to read opencode config: ${message}`, undefined, requestId);
          }

          let baseURL: string;
          let baseURLSource = "default";
          const configuredBaseURL = resolveConfiguredBaseUrl(config);
          const configuredResponseSchema = resolveResponseSchemaMode(config);
          const useResponseSchema = configuredResponseSchema?.value ?? DEFAULT_USE_RESPONSE_SCHEMA;
          const useResponseSchemaSource = configuredResponseSchema?.source ?? "default";
          const baseURLCandidates = collectBaseUrlDebug(config);
          if (configuredBaseURL) baseURLSource = configuredBaseURL.source;
          try {
            baseURL = normalizeBaseUrl(configuredBaseURL?.value);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createError(
              `invalid ${baseURLSource}: ${message}`,
              "Fix the provider baseURL override or remove it.",
              requestId,
            );
          }

          await client.app
            .log({
              body: {
                service: "gemini-tools",
                level: "debug",
                message: "google_search config resolution",
                extra: {
                  requestId,
                  baseURL,
                  baseURLSource,
                  baseURLCandidates,
                  useResponseSchema,
                  useResponseSchemaSource,
                },
              },
            })
            .catch(() => {});

          await client.app
            .log({
              body: {
                service: "gemini-tools",
                level: "debug",
                message: "google_search request",
                extra: {
                  requestId,
                  baseURL,
                  baseURLSource,
                  model: DEFAULT_MODEL,
                  urlCount: urls.length,
                  thinking: Boolean(args.thinking),
                  useResponseSchema,
                },
              },
            })
            .catch(() => {});

          const systemInstruction = buildSystemInstruction(Boolean(args.thinking));
          const userPrompt = buildUserPrompt(query, urls, Boolean(args.thinking));
          const thinkingBudget = args.thinking ? THINKING_BUDGET_DEEP : THINKING_BUDGET_FAST;
          const timeoutMs = clampTimeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

          const payload = {
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            contents: [
              {
                role: "user",
                parts: [{ text: userPrompt }],
              },
            ],
            tools: urls.length > 0 ? [{ googleSearch: {} }, { urlContext: {} }] : [{ googleSearch: {} }],
            generationConfig: {
              thinkingConfig: {
                thinkingBudget,
                includeThoughts: false,
              },
            },
          };

          const responseSchema = {
            type: "object",
            properties: {
              answer: { type: "string" },
              sources: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    url: { type: "string" },
                  },
                  required: ["title", "url"],
                },
              },
              searchQueries: { type: "array", items: { type: "string" } },
              urlsRetrieved: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    url: { type: "string" },
                    status: { type: "string" },
                  },
                  required: ["url"],
                },
              },
            },
            required: ["answer", "sources"],
          };

          const endpoint = `${baseURL}/models/${DEFAULT_MODEL}:generateContent`;

          const signals: AbortSignal[] = [];
          if (ctx.abort) signals.push(ctx.abort);
          signals.push(AbortSignal.timeout(timeoutMs));
          const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

          const makeRequest = async (useSchema: boolean) => {
            const body = useSchema
              ? {
                  ...payload,
                  generationConfig: {
                    ...payload.generationConfig,
                    responseMimeType: "application/json",
                    responseSchema,
                  },
                }
              : payload;

            return fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": googleAuth.key,
              },
              body: JSON.stringify(body),
              signal,
            });
          };

          const requestWithRetry = async (useSchema: boolean) => {
            let lastResponse: Response | undefined;
            for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length + 1; attempt += 1) {
              await client.app
                .log({
                  body: {
                    service: "gemini-tools",
                    level: "debug",
                    message: "google_search request attempt",
                    extra: {
                      requestId,
                      endpoint,
                      attempt: attempt + 1,
                      maxAttempts: RETRY_BACKOFF_MS.length + 1,
                      useSchema,
                      timeoutMs,
                    },
                  },
                })
                .catch(() => {});

              const response = await makeRequest(useSchema);
              lastResponse = response;
              await client.app
                .log({
                  body: {
                    service: "gemini-tools",
                    level: "debug",
                    message: "google_search response",
                    extra: {
                      requestId,
                      endpoint,
                      attempt: attempt + 1,
                      useSchema,
                      status: response.status,
                      statusText: response.statusText,
                    },
                  },
                })
                .catch(() => {});
              if (response.status < 500 || response.status >= 600) return response;
              if (attempt < RETRY_BACKOFF_MS.length) {
                const delay = RETRY_BACKOFF_MS[attempt];
                if (delay !== undefined) await sleep(delay);
                continue;
              }
              return response;
            }
            return lastResponse as Response;
          };

          try {
            let response = await requestWithRetry(useResponseSchema);
            if (useResponseSchema && !response.ok) {
              await client.app
                .log({
                  body: {
                    service: "gemini-tools",
                    level: "warn",
                    message: "google_search schema request failed, retrying without schema",
                    extra: {
                      requestId,
                      endpoint,
                      status: response.status,
                      statusText: response.statusText,
                    },
                  },
                })
                .catch(() => {});
              response = await requestWithRetry(false);
            }

            if (!response.ok) {
              const errorText = await response.text();
              const snippet = errorText.length > 2000 ? `${errorText.slice(0, 2000)}...` : errorText;
              await client.app
                .log({
                  body: {
                    service: "gemini-tools",
                    level: "error",
                    message: "google_search request failed",
                    extra: {
                      requestId,
                      endpoint,
                      status: response.status,
                      statusText: response.statusText,
                      bodySnippet: snippet,
                    },
                  },
                })
                .catch(() => {});
              return createError(
                `Gemini API error: ${response.status} ${response.statusText}\n${snippet}`,
                "Verify the api key, model access, and baseURL.",
                requestId,
              );
            }

            const data = (await response.json()) as GeminiResponse;
            const result = parseSearchResponse(data);
            if (result.text.startsWith("Error:")) {
              return createError(result.text.replace(/^Error:\s*/, ""), undefined, requestId);
            }
            return formatSearchResult(result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return createError(`Gemini API request failed: ${message}`, "Try again or reduce timeout.", requestId);
          }
        },
      }),
    },
  };
};
