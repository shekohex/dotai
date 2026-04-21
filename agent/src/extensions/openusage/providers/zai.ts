import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { downloadCliproxyAuthFile, resolveCliproxySelectedAccount } from "../cliproxy.js";
import type { OpenUsageRuntimeState, UsageProvider, UsageSnapshot } from "../types.js";
import { asRecord, clampPercent, readNumber, readString, toIsoTimestamp } from "./shared.js";

const SUBSCRIPTION_URL = "https://api.z.ai/api/biz/subscription/list";
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const zaiUsageProvider: UsageProvider = {
  id: "zai",
  displayName: "Z.ai",
  matchesModel(provider) {
    const normalizedProvider = provider.trim().toLowerCase();
    return normalizedProvider === "zai" || normalizedProvider === "zai-coding-plan";
  },
  async fetchSnapshot(ctx, state) {
    const credential = await resolveZaiCredential(ctx, state);
    const payload = await fetchZaiUsagePayloads(ctx, credential.apiKey);
    return buildZaiSnapshot(credential, payload);
  },
};

async function fetchZaiUsagePayloads(
  ctx: ExtensionContext,
  apiKey: string,
): Promise<{
  quotaPayload: Record<string, unknown>;
  subscriptionPayload?: Record<string, unknown>;
}> {
  const [subscriptionResponse, quotaResponse] = await Promise.all([
    fetch(SUBSCRIPTION_URL, {
      method: "GET",
      headers: buildHeaders(apiKey),
      signal: ctx.signal,
    }),
    fetch(QUOTA_URL, {
      method: "GET",
      headers: buildHeaders(apiKey),
      signal: ctx.signal,
    }),
  ]);

  if (quotaResponse.status === 401 || quotaResponse.status === 403) {
    throw new Error(
      "Z.ai auth unavailable. Configure provider 'zai' or choose a cliproxy account.",
    );
  }
  if (!quotaResponse.ok) {
    throw new Error(`Z.ai quota failed: ${quotaResponse.status} ${quotaResponse.statusText}`);
  }

  const quotaPayload = asRecord(await quotaResponse.json());
  if (!quotaPayload) {
    throw new Error("Z.ai quota response is not an object");
  }

  return {
    quotaPayload,
    subscriptionPayload: subscriptionResponse.ok
      ? asRecord(await subscriptionResponse.json())
      : undefined,
  };
}

function buildZaiSnapshot(
  credential: ZaiCredential,
  payload: { quotaPayload: Record<string, unknown>; subscriptionPayload?: Record<string, unknown> },
): UsageSnapshot {
  const limits = listLimits(payload.quotaPayload);
  const sessionLimit = findLimit(limits, "TOKENS_LIMIT", 3);
  const weeklyLimit = findLimit(limits, "TOKENS_LIMIT", 6);
  const sourceSummary = credential.source === "cliproxy" ? "cliproxy account" : "host auth";
  const snapshot: UsageSnapshot = {
    providerId: "zai",
    displayName: "Z.ai",
    plan: extractPlan(payload.subscriptionPayload),
    source: credential.source,
    accountLabel: credential.accountLabel,
    fetchedAt: Date.now(),
    summary: sourceSummary,
  };

  if (sessionLimit) {
    snapshot.session5h = {
      used: clampPercent(readNumber(sessionLimit.percentage) ?? 0),
      limit: 100,
      resetsAt: toIsoTimestamp(readNumber(sessionLimit.nextResetTime)),
      periodDurationMs: FIVE_HOURS_MS,
    };
  }
  if (weeklyLimit) {
    snapshot.weekly = {
      used: clampPercent(readNumber(weeklyLimit.percentage) ?? 0),
      limit: 100,
      resetsAt: toIsoTimestamp(readNumber(weeklyLimit.nextResetTime)),
      periodDurationMs: SEVEN_DAYS_MS,
    };
  }
  if (!snapshot.session5h && !snapshot.weekly) {
    snapshot.summary = `${sourceSummary}, no token-window quota in response`;
  }
  return snapshot;
}

type ZaiCredential = {
  apiKey: string;
  accountLabel?: string;
  source: "host" | "cliproxy";
};

async function resolveZaiCredential(
  ctx: ExtensionContext,
  state: OpenUsageRuntimeState,
): Promise<ZaiCredential> {
  const selectedCliproxyAccount = state.persisted.selectedAccounts.zai?.trim();
  if (selectedCliproxyAccount !== undefined && selectedCliproxyAccount.length > 0) {
    const cliproxy = await resolveCliproxyZaiCredential(ctx, state);
    if (cliproxy) {
      return cliproxy;
    }
  }

  const hostApiKey = await resolveHostZaiApiKey(ctx);
  if (hostApiKey !== undefined && hostApiKey.length > 0) {
    return {
      apiKey: hostApiKey,
      source: "host",
    };
  }

  const cliproxy = await resolveCliproxyZaiCredential(ctx, state);
  if (cliproxy) {
    return cliproxy;
  }

  throw new Error(
    "Z.ai auth unavailable. Configure provider 'zai' or 'zai-coding-plan', or configure cliproxy.",
  );
}

async function resolveHostZaiApiKey(ctx: ExtensionContext): Promise<string | undefined> {
  const providerCandidates = ["zai", ctx.model?.provider, "zai-coding-plan"];
  const seen = new Set<string>();

  for (const candidate of providerCandidates) {
    const normalized = candidate?.trim();
    if (normalized === undefined || normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    const apiKey = (await ctx.modelRegistry.getApiKeyForProvider(normalized))?.trim();
    if (apiKey !== undefined && apiKey.length > 0) {
      return apiKey;
    }
  }

  return undefined;
}

async function resolveCliproxyZaiCredential(
  ctx: ExtensionContext,
  state: OpenUsageRuntimeState,
): Promise<ZaiCredential | undefined> {
  const account = await resolveCliproxySelectedAccount(ctx, state, "zai");
  if (!account) {
    return undefined;
  }

  const payload = await downloadCliproxyAuthFile(ctx, account.file.name);
  const apiKey = readDeepString(payload, [
    ["apiKey"],
    ["api_key"],
    ["key"],
    ["token"],
    ["access_token"],
    ["accessToken"],
    ["zai", "apiKey"],
    ["zai", "api_key"],
    ["credentials", "apiKey"],
    ["credentials", "api_key"],
    ["credentials", "key"],
    ["data", "apiKey"],
    ["data", "api_key"],
  ]);

  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`cliproxy Z.ai auth file '${account.file.name}' is missing an API key`);
  }

  return {
    apiKey,
    accountLabel: account.label,
    source: "cliproxy",
  };
}

function buildHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

function extractPlan(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) {
    return undefined;
  }

  const data: unknown[] = Array.isArray(payload.data) ? payload.data : [];
  const first = data[0];
  if (first === undefined || first === null || typeof first !== "object" || Array.isArray(first)) {
    return undefined;
  }

  return readString(asRecord(first)?.productName);
}

function findLimit(
  items: unknown[],
  type: string,
  unit?: number,
): Record<string, unknown> | undefined {
  let fallback: Record<string, unknown> | undefined;

  for (const item of items) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }

    const itemType = readString(record.type) ?? readString(record.name);
    if (itemType !== type) {
      continue;
    }

    if (unit === undefined) {
      return record;
    }

    const itemUnit = readNumber(record.unit);
    if (itemUnit === unit) {
      return record;
    }

    if (!fallback && itemUnit === undefined) {
      fallback = record;
    }
  }

  return fallback;
}

function listLimits(payload: Record<string, unknown>): unknown[] {
  const container = payload.data ?? payload;

  if (Array.isArray(container)) {
    return container;
  }

  const record = asRecord(container);
  if (!record) {
    return [];
  }

  return Array.isArray(record.limits) ? record.limits : [];
}

function readDeepString(value: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path) {
      if (
        current === undefined ||
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current)
      ) {
        current = undefined;
        break;
      }
      current = asRecord(current)?.[key];
    }

    const found = readString(current);
    if (found !== undefined && found.length > 0) {
      return found;
    }
  }

  return undefined;
}
