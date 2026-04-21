import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  CLIPROXY_AUTH_PROVIDER,
  type CliproxyAccount,
  type CliproxyAccountsByProvider,
  type CliproxyConfig,
  type OpenUsageRuntimeState,
  type SupportedProviderId,
} from "./types.js";
import {
  API_KEY_ENV_KEYS,
  BASE_URL_ENV_KEYS,
  CLIPROXY_READINESS_PATH,
  buildAccountsByProvider,
  detectCliproxyState,
  firstEnv,
  hasText,
  normalizeBaseUrl,
  parseAuthFiles,
  probeCliproxyCandidate,
  type CliproxyState,
} from "./cliproxy-helpers.js";

export type { CliproxyState } from "./cliproxy-helpers.js";

let cliproxyStatePromise: Promise<CliproxyState> | undefined;

export async function resolveCliproxyConfig(
  ctx: ExtensionContext,
): Promise<CliproxyConfig | undefined> {
  const apiKey = (
    (await ctx.modelRegistry.authStorage.getApiKey(CLIPROXY_AUTH_PROVIDER, {
      includeFallback: true,
    })) ?? firstEnv(API_KEY_ENV_KEYS)
  )?.trim();

  if (!hasText(apiKey)) {
    return undefined;
  }

  const state = await resolveCliproxyState(ctx, apiKey);
  if (!hasText(state.baseUrl)) {
    return undefined;
  }

  return { baseUrl: state.baseUrl, apiKey };
}

export async function resolveCliproxyState(
  ctx: ExtensionContext,
  apiKeyOverride?: string,
): Promise<CliproxyState> {
  const apiKey =
    apiKeyOverride ??
    (
      (await ctx.modelRegistry.authStorage.getApiKey(CLIPROXY_AUTH_PROVIDER, {
        includeFallback: true,
      })) ?? firstEnv(API_KEY_ENV_KEYS)
    )?.trim();

  if (!hasText(apiKey)) {
    return {
      healthy: false,
      label: "missing-auth",
      error: `Missing ${CLIPROXY_AUTH_PROVIDER} auth`,
      source: "missing-auth",
    };
  }

  const envBaseUrl = normalizeBaseUrl(firstEnv(BASE_URL_ENV_KEYS));
  if (hasText(envBaseUrl)) {
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

  cliproxyStatePromise ??= detectCliproxyState(apiKey);

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
    throw new Error(
      `cliproxy auth-file download failed: ${response.status} ${response.statusText}`,
    );
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
  if (!hasText(selectedValue)) {
    return accounts[0];
  }

  return accounts.find((account) => account.value === selectedValue) ?? accounts[0];
}
