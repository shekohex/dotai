import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const HonchoSessionStrategySchema = Type.Union([
  Type.Literal("repo"),
  Type.Literal("git-branch"),
  Type.Literal("directory"),
]);

const HonchoHostConfigSchema = Type.Object(
  {
    workspace: Type.Optional(Type.String()),
    aiPeer: Type.Optional(Type.String()),
    endpoint: Type.Optional(Type.String()),
    sessionStrategy: Type.Optional(HonchoSessionStrategySchema),
    contextTokens: Type.Optional(Type.Number()),
    promptMaxChars: Type.Optional(Type.Number()),
    maxMessageLength: Type.Optional(Type.Number()),
    searchLimit: Type.Optional(Type.Number()),
    toolPreviewLength: Type.Optional(Type.Number()),
    timeoutMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

const HonchoConfigFileSchema = Type.Object(
  {
    apiKey: Type.Optional(Type.String()),
    peerName: Type.Optional(Type.String()),
    hosts: Type.Optional(
      Type.Object({ pi: Type.Optional(HonchoHostConfigSchema) }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);

type HonchoConfigFile = Static<typeof HonchoConfigFileSchema>;
export type HonchoSessionStrategy = Static<typeof HonchoSessionStrategySchema>;

export interface HonchoMemoryConfig {
  enabled: boolean;
  apiKey?: string;
  credentialSource: "environment" | "file" | "none";
  baseURL?: string;
  workspaceId: string;
  userPeerId: string;
  aiPeerId: string;
  sessionStrategy: HonchoSessionStrategy;
  contextTokens: number;
  promptMaxChars: number;
  maxMessageLength: number;
  searchLimit: number;
  toolPreviewLength: number;
  timeoutMs: number;
}

export interface ResolveHonchoConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  username?: string;
}

const DEFAULT_CONTEXT_TOKENS = 1_200;
const DEFAULT_PROMPT_MAX_CHARS = 6_000;
const DEFAULT_MAX_MESSAGE_LENGTH = 8_000;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_TOOL_PREVIEW_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_PROMPT_MAX_CHARS = 512;
const MAX_SEARCH_LIMIT = 100;

function normalizedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function positiveInteger(
  value: number | string | undefined,
  fallback: number,
  options?: { minimum?: number; maximum?: number },
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  if (options?.minimum !== undefined && parsed < options.minimum) return fallback;
  if (options?.maximum !== undefined && parsed > options.maximum) return fallback;
  return parsed;
}

function sessionStrategy(value: string | undefined): HonchoSessionStrategy {
  return Value.Check(HonchoSessionStrategySchema, value) ? value : "repo";
}

async function readHonchoConfigFile(configPath: string): Promise<HonchoConfigFile | undefined> {
  try {
    return Value.Parse(
      HonchoConfigFileSchema,
      JSON.parse(await readFile(configPath, { encoding: "utf8" })),
    );
  } catch {
    return undefined;
  }
}

function resolveEnabled(value: string | undefined, apiKey: string | undefined): boolean {
  return value === "true" && apiKey !== undefined;
}

export async function resolveHonchoConfig(
  options: ResolveHonchoConfigOptions = {},
): Promise<HonchoMemoryConfig> {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? join(homedir(), ".honcho", "config.json");
  const file = await readHonchoConfigFile(configPath);
  const host = file?.hosts?.pi;
  const envApiKey = normalizedString(env.HONCHO_API_KEY);
  const fileApiKey = normalizedString(file?.apiKey);
  const apiKey = envApiKey ?? fileApiKey;
  let credentialSource: HonchoMemoryConfig["credentialSource"] = "none";
  if (envApiKey !== undefined) credentialSource = "environment";
  else if (fileApiKey !== undefined) credentialSource = "file";

  return {
    enabled: resolveEnabled(env.HONCHO_ENABLED, apiKey),
    apiKey,
    credentialSource,
    baseURL: normalizedString(env.HONCHO_URL) ?? normalizedString(host?.endpoint),
    workspaceId:
      normalizedString(env.HONCHO_WORKSPACE_ID) ?? normalizedString(host?.workspace) ?? "pi",
    userPeerId:
      normalizedString(env.HONCHO_PEER_NAME) ??
      normalizedString(file?.peerName) ??
      options.username ??
      userInfo().username,
    aiPeerId: normalizedString(env.HONCHO_AI_PEER) ?? normalizedString(host?.aiPeer) ?? "pi",
    sessionStrategy: sessionStrategy(env.HONCHO_SESSION_STRATEGY ?? host?.sessionStrategy),
    contextTokens: positiveInteger(
      env.HONCHO_CONTEXT_TOKENS ?? host?.contextTokens,
      DEFAULT_CONTEXT_TOKENS,
    ),
    promptMaxChars: positiveInteger(
      env.HONCHO_PROMPT_MAX_CHARS ?? host?.promptMaxChars,
      DEFAULT_PROMPT_MAX_CHARS,
      { minimum: MIN_PROMPT_MAX_CHARS },
    ),
    maxMessageLength: positiveInteger(
      env.HONCHO_MAX_MESSAGE_LENGTH ?? host?.maxMessageLength,
      DEFAULT_MAX_MESSAGE_LENGTH,
    ),
    searchLimit: positiveInteger(
      env.HONCHO_SEARCH_LIMIT ?? host?.searchLimit,
      DEFAULT_SEARCH_LIMIT,
      { maximum: MAX_SEARCH_LIMIT },
    ),
    toolPreviewLength: positiveInteger(
      env.HONCHO_TOOL_PREVIEW_LENGTH ?? host?.toolPreviewLength,
      DEFAULT_TOOL_PREVIEW_LENGTH,
    ),
    timeoutMs: positiveInteger(env.HONCHO_TIMEOUT_MS ?? host?.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

export const _test = {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_PROMPT_MAX_CHARS,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOL_PREVIEW_LENGTH,
};
