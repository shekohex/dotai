import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { downloadCliproxyAuthFile, resolveCliproxySelectedAccount } from "../cliproxy.js";
import type { OpenUsageRuntimeState, UsageProvider, UsageSnapshot } from "../types.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const codexUsageProvider: UsageProvider = {
  id: "codex",
  displayName: "Codex",
  matchesModel(provider, modelId) {
    const normalizedProvider = provider.trim().toLowerCase();
    const normalizedModelId = modelId.trim().toLowerCase();
    return (
      normalizedProvider === "codex-openai" ||
      normalizedProvider === "openai-codex" ||
      normalizedModelId.includes("codex")
    );
  },
  async fetchSnapshot(ctx, state) {
    const credential = await resolveCodexCredential(ctx, state);
    let response = await fetchUsage(ctx, credential.accessToken, credential.accountId);

    if (response.status === 401 && credential.refreshToken && credential.source === "cliproxy") {
      const refreshed = await refreshCodexToken(ctx, credential.refreshToken);
      response = await fetchUsage(ctx, refreshed.accessToken, refreshed.accountId ?? credential.accountId);
    }

    if (response.status === 401) {
      throw new Error("Codex auth unavailable. Login with /login openai-codex or choose a cliproxy account.");
    }

    if (!response.ok) {
      throw new Error(`Codex usage failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    const rateLimit = asRecord(body.rate_limit);
    const primaryWindow = asRecord(rateLimit?.primary_window);
    const secondaryWindow = asRecord(rateLimit?.secondary_window);

    const sessionUsed =
      readNumber(response.headers.get("x-codex-primary-used-percent")) ??
      readNumber(primaryWindow?.used_percent);
    const weeklyUsed =
      readNumber(response.headers.get("x-codex-secondary-used-percent")) ??
      readNumber(secondaryWindow?.used_percent);

    const snapshot: UsageSnapshot = {
      providerId: "codex",
      displayName: "Codex",
      plan: readString(body.plan_type),
      source: credential.source,
      accountLabel: credential.accountLabel,
      fetchedAt: Date.now(),
      summary: credential.source === "cliproxy" ? "cliproxy account" : "host auth",
    };

    if (sessionUsed !== undefined) {
      snapshot.session5h = {
        used: clampPercent(sessionUsed),
        limit: 100,
        resetsAt: resolveResetAt(primaryWindow),
      };
    }

    if (weeklyUsed !== undefined) {
      snapshot.weekly = {
        used: clampPercent(weeklyUsed),
        limit: 100,
        resetsAt: resolveResetAt(secondaryWindow),
      };
    }

    if (!snapshot.session5h && !snapshot.weekly) {
      throw new Error("Codex usage response did not include 5h or weekly limits.");
    }

    return snapshot;
  },
};

type CodexCredential = {
  accessToken: string;
  accountId: string;
  refreshToken?: string;
  accountLabel?: string;
  source: "host" | "cliproxy";
};

async function resolveCodexCredential(
  ctx: ExtensionContext,
  state: OpenUsageRuntimeState,
): Promise<CodexCredential> {
  const selectedCliproxyAccount = state.persisted.selectedAccounts.codex?.trim();
  if (selectedCliproxyAccount) {
    const cliproxy = await resolveCliproxyCodexCredential(ctx, state);
    if (cliproxy) {
      return cliproxy;
    }
  }

  const hostCredential = await resolveHostCodexCredential(ctx);
  if (hostCredential) {
    return hostCredential;
  }

  const cliproxy = await resolveCliproxyCodexCredential(ctx, state);
  if (cliproxy) {
    return cliproxy;
  }

  throw new Error("Codex auth unavailable. Login with /login openai-codex or configure cliproxy.");
}

async function resolveHostCodexCredential(ctx: ExtensionContext): Promise<CodexCredential | undefined> {
  const cred = ctx.modelRegistry.authStorage.get("openai-codex");
  const apiKey = await ctx.modelRegistry.authStorage.getApiKey("openai-codex", {
    includeFallback: true,
  });

  if (!apiKey) {
    return undefined;
  }

  const oauthAccountId =
    cred && cred.type === "oauth" ? readString((cred as Record<string, unknown>).accountId) : undefined;
  const accountId = oauthAccountId ?? extractAccountId(apiKey);
  if (!accountId) {
    throw new Error("Failed to resolve Codex account id from host auth.");
  }

  return {
    accessToken: apiKey,
    accountId,
    source: "host",
  };
}

async function resolveCliproxyCodexCredential(
  ctx: ExtensionContext,
  state: OpenUsageRuntimeState,
): Promise<CodexCredential | undefined> {
  const account = await resolveCliproxySelectedAccount(ctx, state, "codex");
  if (!account) {
    return undefined;
  }

  const payload = await downloadCliproxyAuthFile(ctx, account.file.name);
  const root = asRecord(payload);
  const tokens = asRecord(root?.tokens);
  const accessToken =
    readString(root?.access_token) ??
    readString(root?.accessToken) ??
    readString(tokens?.access_token) ??
    readString(tokens?.accessToken);
  const refreshToken =
    readString(root?.refresh_token) ??
    readString(root?.refreshToken) ??
    readString(tokens?.refresh_token) ??
    readString(tokens?.refreshToken);
  const accountId =
    readString(root?.account_id) ??
    readString(root?.accountId) ??
    readString(tokens?.account_id) ??
    readString(tokens?.accountId) ??
    (accessToken ? extractAccountId(accessToken) : undefined);

  if (!accessToken || !accountId) {
    throw new Error(`cliproxy Codex auth file '${account.file.name}' is missing access_token/account_id`);
  }

  return {
    accessToken,
    refreshToken,
    accountId,
    accountLabel: account.label,
    source: "cliproxy",
  };
}

async function fetchUsage(
  ctx: ExtensionContext,
  accessToken: string,
  accountId: string,
): Promise<Response> {
  return fetch(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "pi",
      "chatgpt-account-id": accountId,
    },
    signal: ctx.signal,
  });
}

async function refreshCodexToken(
  ctx: ExtensionContext,
  refreshToken: string,
): Promise<{ accessToken: string; accountId?: string }> {
  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal: ctx.signal,
  });

  if (!response.ok) {
    throw new Error(`Codex token refresh failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = readString(body.access_token);
  if (!accessToken) {
    throw new Error("Codex refresh response missing access_token");
  }

  return {
    accessToken,
    accountId: extractAccountId(accessToken),
  };
}

function resolveResetAt(window: Record<string, unknown> | undefined): string | undefined {
  if (!window) {
    return undefined;
  }

  const resetAt = readNumber(window.reset_at);
  if (resetAt !== undefined) {
    return new Date(resetAt * 1000).toISOString();
  }

  const resetAfterSeconds = readNumber(window.reset_after_seconds);
  if (resetAfterSeconds !== undefined) {
    return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
  }

  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function extractAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return undefined;
    }

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const chatgpt = asRecord(payload["https://api.openai.com/auth"]);
    const accountId = readString(chatgpt?.chatgpt_account_id);
    return accountId ?? undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function readNumber(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}
