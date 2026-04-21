import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  CliproxyAccount,
  CliproxyAccountsByProvider,
  CliproxyAuthFile,
  SupportedProviderId,
} from "./types.js";

export const BASE_URL_ENV_KEYS = [
  "CLIPROXYAPI_BASE_URL",
  "CLIPROXY_BASE_URL",
  "CLIPROXYAPI_URL",
] as const;
export const API_KEY_ENV_KEYS = [
  "CLIPROXYAPI_API_KEY",
  "CLIPROXY_API_KEY",
  "CLIPROXYAPI_MANAGEMENT_KEY",
] as const;
export const CLIPROXY_READINESS_PATH = "/v0/management/auth-files";
export const CLIPROXY_CANDIDATES = [
  { label: "lan", origin: "http://192.168.1.116:8317" },
  { label: "tail", origin: "http://100.100.1.116:8317" },
  { label: "public", origin: "https://ai-gateway.0iq.xyz/proxy" },
] as const;

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

export type CliproxyState = {
  healthy: boolean;
  label: string;
  origin?: string;
  baseUrl?: string;
  checkedPath?: string;
  error?: string;
  source: "env" | "detected" | "missing-auth" | "offline";
};

export function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export function parseAuthFiles(payload: unknown): CliproxyAuthFile[] {
  const payloadRecord = asRecord(payload);
  let items: unknown[] = [];
  if (Array.isArray(payload)) {
    items = payload;
  } else if (Array.isArray(payloadRecord?.files)) {
    items = payloadRecord.files;
  }
  const files: CliproxyAuthFile[] = [];
  for (const item of items) {
    if (item === undefined || item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const name = readString(record.name);
    if (!hasText(name)) {
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

export function buildAccountsByProvider(files: CliproxyAuthFile[]): CliproxyAccountsByProvider {
  const byProvider: CliproxyAccountsByProvider = {};
  const seen = new Map<SupportedProviderId, Set<string>>();
  for (const file of files) {
    if (file.disabled || file.unavailable) {
      continue;
    }
    const providerId = mapCliproxyProvider(file.provider);
    if (!providerId) {
      continue;
    }
    const selectionValue = (file.authIndex ?? file.id ?? file.name).trim();
    if (!hasText(selectionValue)) {
      continue;
    }
    if (!seen.has(providerId)) {
      seen.set(providerId, new Set());
    }
    if (seen.get(providerId)?.has(selectionValue) === true) {
      continue;
    }
    const trimmedEmail = file.email?.trim();
    seen.get(providerId)?.add(selectionValue);
    const account: CliproxyAccount = {
      value: selectionValue,
      label: hasText(trimmedEmail) ? `${trimmedEmail} (${file.name})` : file.name,
      file,
    };
    byProvider[providerId] ??= [];
    byProvider[providerId]?.push(account);
  }
  return byProvider;
}

export async function detectCliproxyState(apiKey: string): Promise<CliproxyState> {
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
  return { healthy: false, label: "offline", error: lastError, source: "offline" };
}

export async function probeCliproxyCandidate(
  candidate: { label: string; origin: string },
  apiKey: string,
): Promise<{ healthy: boolean; checkedPath?: string; error?: string }> {
  const origin = normalizeBaseUrl(candidate.origin);
  if (!hasText(origin)) {
    return { healthy: false, error: `${candidate.label} invalid origin` };
  }
  try {
    const response = await fetch(`${origin}${CLIPROXY_READINESS_PATH}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
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

export function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!hasText(trimmed)) {
    return undefined;
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const normalized = withProtocol.replace(/\/+$/, "").replace(/\/v0\/management$/i, "");
  return normalized || undefined;
}

export function firstEnv(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (hasText(value)) {
      return value;
    }
  }
  return undefined;
}

function mapCliproxyProvider(value: string): SupportedProviderId | undefined {
  const normalized = value.trim().toLowerCase();
  if (!hasText(normalized)) {
    return undefined;
  }
  if (normalized === "codex" || normalized === "openai-codex") {
    return "codex";
  }
  if (
    normalized === "google" ||
    normalized === "gemini" ||
    normalized === "gemini-cli" ||
    normalized === "google-gemini-cli"
  ) {
    return "google";
  }
  if (normalized === "zai" || normalized === "glm") {
    return "zai";
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Value.Check(UnknownRecordSchema, value)) {
    return undefined;
  }
  return Value.Parse(UnknownRecordSchema, value);
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
