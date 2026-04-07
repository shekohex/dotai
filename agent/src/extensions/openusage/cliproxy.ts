import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  CLIPROXY_AUTH_PROVIDER,
  type CliproxyAccount,
  type CliproxyAccountsByProvider,
  type CliproxyAuthFile,
  type CliproxyConfig,
  type OpenUsageRuntimeState,
  type SupportedProviderId,
} from "./types.js";

const BASE_URL_ENV_KEYS = ["CLIPROXYAPI_BASE_URL", "CLIPROXY_BASE_URL", "CLIPROXYAPI_URL"] as const;
const API_KEY_ENV_KEYS = ["CLIPROXYAPI_API_KEY", "CLIPROXY_API_KEY", "CLIPROXYAPI_MANAGEMENT_KEY"] as const;
const CLIPROXY_READINESS_PATH = "/v0/management/auth-files";
const CLIPROXY_CANDIDATES = [
  { label: "lan", origin: "http://192.168.1.116:8317" },
  { label: "tail", origin: "http://100.100.1.116:8317" },
  { label: "public", origin: "https://ai-gateway.0iq.xyz/proxy" },
] as const;

export type CliproxyState = {
  healthy: boolean;
  label: string;
  origin?: string;
  baseUrl?: string;
  checkedPath?: string;
  error?: string;
  source: "env" | "detected" | "missing-auth" | "offline";
};

let cliproxyStatePromise: Promise<CliproxyState> | undefined;

export async function resolveCliproxyConfig(
  ctx: ExtensionContext,
): Promise<CliproxyConfig | undefined> {
  const apiKey = ((await ctx.modelRegistry.authStorage.getApiKey(CLIPROXY_AUTH_PROVIDER, {
    includeFallback: true,
  })) ?? firstEnv(API_KEY_ENV_KEYS))?.trim();

  if (!apiKey) {
    return undefined;
  }

  const state = await resolveCliproxyState(ctx, apiKey);
  if (!state.baseUrl) {
    return undefined;
  }

  return { baseUrl: state.baseUrl, apiKey };
}

export async function resolveCliproxyState(
  ctx: ExtensionContext,
  apiKeyOverride?: string,
): Promise<CliproxyState> {
  const apiKey = apiKeyOverride ?? ((await ctx.modelRegistry.authStorage.getApiKey(CLIPROXY_AUTH_PROVIDER, {
    includeFallback: true,
  })) ?? firstEnv(API_KEY_ENV_KEYS))?.trim();

  if (!apiKey) {
    return {
      healthy: false,
      label: "missing-auth",
      error: `Missing ${CLIPROXY_AUTH_PROVIDER} auth`,
      source: "missing-auth",
    };
  }

  const envBaseUrl = normalizeBaseUrl(firstEnv(BASE_URL_ENV_KEYS));
  if (envBaseUrl) {
    const result = await probeCliproxyCandidate({ label: "env", origin: envBaseUrl }, apiKey);
    return {
      healthy: result.healthy,
      label: "env",
      origin: envBaseUrl,
      baseUrl: envBaseUrl,
      checkedPath: result.checkedPath,
      error: result.error,
      source: "env",
    };
  }

  if (!cliproxyStatePromise) {
    cliproxyStatePromise = detectCliproxyState(apiKey);
  }

  return cliproxyStatePromise;
}

export async function listCliproxyAccounts(
  ctx: ExtensionContext,
): Promise<CliproxyAccountsByProvider> {
  const config = await resolveCliproxyConfig(ctx);
  if (!config) {
    return {};
  }

  const response = await fetch(`${config.baseUrl}${CLIPROXY_READINESS_PATH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "application/json",
    },
    signal: ctx.signal,
  });

  if (!response.ok) {
    throw new Error(`cliproxy auth-files failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  const files = parseAuthFiles(payload);
  return buildAccountsByProvider(files);
}

export async function downloadCliproxyAuthFile(
  ctx: ExtensionContext,
  fileName: string,
): Promise<unknown> {
  const config = await resolveCliproxyConfig(ctx);
  if (!config) {
    throw new Error("cliproxy not configured");
  }

  const trimmedFileName = fileName.trim();
  if (!trimmedFileName) {
    throw new Error("cliproxy auth file name is empty");
  }

  const response = await fetch(
    `${config.baseUrl}/v0/management/auth-files/download?name=${encodeURIComponent(trimmedFileName)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json, text/plain;q=0.9",
      },
      signal: ctx.signal,
    },
  );

  if (!response.ok) {
    throw new Error(`cliproxy auth-file download failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("cliproxy auth-file payload is not valid JSON");
  }
}

export async function resolveCliproxySelectedAccount(
  ctx: ExtensionContext,
  state: OpenUsageRuntimeState,
  providerId: SupportedProviderId,
): Promise<CliproxyAccount | undefined> {
  const accountsByProvider = await listCliproxyAccounts(ctx);
  const accounts = accountsByProvider[providerId] ?? [];
  if (accounts.length === 0) {
    return undefined;
  }

  const selectedValue = state.persisted.selectedAccounts[providerId]?.trim();
  if (!selectedValue) {
    return accounts[0];
  }

  return accounts.find((account) => account.value === selectedValue) ?? accounts[0];
}

function parseAuthFiles(payload: unknown): CliproxyAuthFile[] {
  const items = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { files?: unknown }).files)
      ? (payload as { files: unknown[] }).files
      : [];

  const files: CliproxyAuthFile[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const name = readString(record.name);
    if (!name) {
      continue;
    }

    const authIndex = readString(record.authIndex) ?? readString(record.auth_index);
    files.push({
      id: readString(record.id) ?? authIndex ?? name,
      name,
      provider: readString(record.provider) ?? readString(record.type) ?? "unknown",
      email: readString(record.email) ?? readString(record.account) ?? readString(record.username),
      authIndex,
      disabled: readBoolean(record.disabled),
      unavailable: readBoolean(record.unavailable),
      runtimeOnly: readBoolean(record.runtimeOnly) || readBoolean(record.runtime_only),
    });
  }

  return files;
}

function buildAccountsByProvider(files: CliproxyAuthFile[]): CliproxyAccountsByProvider {
  const byProvider: CliproxyAccountsByProvider = {};
  const seen = new Map<SupportedProviderId, Set<string>>();

  for (const file of files) {
    if (file.disabled || file.unavailable) {
      continue;
    }

    const providerId = mapCliproxyProvider(file.provider);
    if (!providerId || providerId === "opencode-go") {
      continue;
    }

    const selectionValue = (file.authIndex ?? file.id ?? file.name).trim();
    if (!selectionValue) {
      continue;
    }

    if (!seen.has(providerId)) {
      seen.set(providerId, new Set());
    }

    if (seen.get(providerId)?.has(selectionValue)) {
      continue;
    }

    seen.get(providerId)?.add(selectionValue);

    const account: CliproxyAccount = {
      value: selectionValue,
      label: file.email?.trim() ? `${file.email.trim()} (${file.name})` : file.name,
      file,
    };

    if (!byProvider[providerId]) {
      byProvider[providerId] = [];
    }

    byProvider[providerId]?.push(account);
  }

  return byProvider;
}

async function detectCliproxyState(apiKey: string): Promise<CliproxyState> {
  let lastError: string | undefined;

  for (const candidate of CLIPROXY_CANDIDATES) {
    const result = await probeCliproxyCandidate(candidate, apiKey);
    if (result.healthy) {
      return {
        healthy: true,
        label: candidate.label,
        origin: candidate.origin,
        baseUrl: candidate.origin,
        checkedPath: result.checkedPath,
        source: "detected",
      };
    }
    lastError = result.error;
  }

  return {
    healthy: false,
    label: "offline",
    error: lastError,
    source: "offline",
  };
}

async function probeCliproxyCandidate(
  candidate: { label: string; origin: string },
  apiKey: string,
): Promise<{ healthy: boolean; checkedPath?: string; error?: string }> {
  const origin = normalizeBaseUrl(candidate.origin);
  if (!origin) {
    return {
      healthy: false,
      error: `${candidate.label} invalid origin`,
    };
  }

  try {
    const response = await fetch(`${origin}${CLIPROXY_READINESS_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(1500),
    });

    if (response.ok || response.status === 401 || response.status === 403) {
      return { healthy: true, checkedPath: CLIPROXY_READINESS_PATH };
    }

    return {
      healthy: false,
      error: `${candidate.label} ${CLIPROXY_READINESS_PATH} -> ${response.status}`,
    };
  } catch (error) {
    return {
      healthy: false,
      error: `${candidate.label} ${CLIPROXY_READINESS_PATH} -> ${formatError(error)}`,
    };
  }
}

function mapCliproxyProvider(value: string): SupportedProviderId | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "codex" || normalized === "openai-codex") {
    return "codex";
  }

  if (normalized === "zai" || normalized === "glm") {
    return "zai";
  }

  if (normalized === "opencode-go") {
    return "opencode-go";
  }

  return undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const normalized = withProtocol.replace(/\/+$/, "").replace(/\/v0\/management$/i, "");
  return normalized || undefined;
}

function firstEnv(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
