import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { downloadCliproxyAuthFile, resolveCliproxySelectedAccount } from "../cliproxy.js";
import type { OpenUsageRuntimeState, UsageProvider, UsageSnapshot } from "../types.js";

const SETTINGS_PATH = path.join(homedir(), ".gemini", "settings.json");
const CREDS_PATH = path.join(homedir(), ".gemini", "oauth_creds.json");
const OAUTH2_JS_PATHS = [
  path.join(
    homedir(),
    ".bun/install/global/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
  ),
  path.join(
    homedir(),
    ".npm-global/lib/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
  ),
  path.join(
    homedir(),
    ".nvm/versions/node/current/lib/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
  ),
  "/opt/homebrew/opt/gemini-cli/libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
  "/usr/local/opt/gemini-cli/libexec/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js",
] as const;

const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const PROJECTS_URL = "https://cloudresourcemanager.googleapis.com/v1/projects";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const IDE_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
  duetProject: "default",
} as const;

export const googleUsageProvider: UsageProvider = {
  id: "google",
  displayName: "Google",
  matchesModel(provider, modelId) {
    const normalizedProvider = provider.trim().toLowerCase();
    const normalizedModelId = modelId.trim().toLowerCase();
    return (
      normalizedProvider === "google" ||
      normalizedProvider === "gemini" ||
      normalizedProvider === "google-gemini-cli" ||
      normalizedProvider === "google-generative-ai" ||
      normalizedProvider === "google-ai-studio" ||
      normalizedProvider === "google-ai" ||
      normalizedModelId.includes("gemini")
    );
  },
  async fetchSnapshot(ctx, state) {
    const credential = await resolveGoogleCredential(ctx, state);
    try {
      return await fetchSnapshotWithCredential(ctx, credential);
    } catch (error) {
      if (credential.source !== "host" || !isAuthError(error)) {
        throw error;
      }

      const cliproxy = await resolveCliproxyGoogleCredential(ctx, state);
      if (!cliproxy) {
        throw error;
      }

      return fetchSnapshotWithCredential(ctx, cliproxy);
    }
  },
};

async function fetchSnapshotWithCredential(
  ctx: ExtensionContext,
  credential: GoogleCredential,
): Promise<UsageSnapshot> {
  const idTokenPayload = decodeJwtPayload(credential.idToken);
  const loadCodeAssistResult = await fetchLoadCodeAssist(ctx, credential);
  const loadCodeAssistData = asRecord(loadCodeAssistResult.data);
  const tier = readFirstStringDeep(loadCodeAssistData, ["tier", "userTier", "subscriptionTier"]);
  const plan = mapTierToPlan(tier, idTokenPayload);
  const projectId = await discoverProjectId(
    ctx,
    loadCodeAssistResult.accessToken,
    loadCodeAssistData,
  );
  const quotaResponse = await fetchQuota(ctx, credential, projectId);
  const quotaData = (await quotaResponse.json()) as unknown;
  const buckets = collectQuotaBuckets(quotaData);
  const proBucket = pickLowestRemainingBucket(filterBuckets(buckets, "pro"));
  const flashBucket = pickLowestRemainingBucket(filterBuckets(buckets, "flash"));
  const sourceSummary = credential.source === "cliproxy" ? "cliproxy account" : "host auth";

  const snapshot: UsageSnapshot = {
    providerId: "google",
    displayName: "Google",
    plan,
    source: credential.source,
    accountLabel:
      credential.accountLabel ?? extractAccountLabel(idTokenPayload, loadCodeAssistData),
    metricLabels: {
      session5h: "Pro 24h",
      weekly: "Flash 24h",
    },
    metricShortLabels: {
      session5h: "pro",
      weekly: "flash",
    },
    fetchedAt: Date.now(),
    summary: joinSummary(sourceSummary, buildSummary(proBucket, flashBucket)),
  };

  if (proBucket) {
    snapshot.session5h = {
      used: clampPercent((1 - clampFraction(proBucket.remainingFraction)) * 100),
      limit: 100,
      resetsAt: toIso(proBucket.resetTime),
      periodDurationMs: TWENTY_FOUR_HOURS_MS,
    };
  }

  if (flashBucket) {
    snapshot.weekly = {
      used: clampPercent((1 - clampFraction(flashBucket.remainingFraction)) * 100),
      limit: 100,
      resetsAt: toIso(flashBucket.resetTime),
      periodDurationMs: TWENTY_FOUR_HOURS_MS,
    };
  }

  return snapshot;
}

type GoogleCredential = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiryDate?: number | string;
  clientId?: string;
  clientSecret?: string;
  source: "host" | "cliproxy";
  accountLabel?: string;
  persistPath?: string;
};

type OauthClientCreds = {
  clientId: string;
  clientSecret: string;
};

type QuotaBucket = {
  modelId: string;
  remainingFraction: number;
  resetTime?: string;
};

type LoadCodeAssistResult = {
  data: unknown;
  accessToken: string;
};

async function resolveGoogleCredential(
  ctx: ExtensionContext,
  state: OpenUsageRuntimeState,
): Promise<GoogleCredential> {
  const selectedCliproxyAccount = state.persisted.selectedAccounts.google?.trim();
  if (selectedCliproxyAccount) {
    const cliproxy = await resolveCliproxyGoogleCredential(ctx, state);
    if (cliproxy) {
      return cliproxy;
    }
  }

  let hostError: unknown;
  try {
    const host = await resolveHostGoogleCredential();
    if (host) {
      return host;
    }
  } catch (error) {
    hostError = error;
  }

  const cliproxy = await resolveCliproxyGoogleCredential(ctx, state);
  if (cliproxy) {
    return cliproxy;
  }

  if (hostError) {
    throw hostError;
  }

  throw new Error("Gemini auth unavailable. Run `gemini auth login` or choose a cliproxy account.");
}

async function resolveHostGoogleCredential(): Promise<GoogleCredential | undefined> {
  const creds = await loadOauthCredsFromFile(CREDS_PATH);
  if (!creds) {
    return undefined;
  }

  await assertSupportedAuthType();
  return {
    ...creds,
    source: "host",
    persistPath: CREDS_PATH,
  };
}

async function resolveCliproxyGoogleCredential(
  ctx: ExtensionContext,
  state: OpenUsageRuntimeState,
): Promise<GoogleCredential | undefined> {
  const account = await resolveCliproxySelectedAccount(ctx, state, "google");
  if (!account) {
    return undefined;
  }

  const payload = await downloadCliproxyAuthFile(ctx, account.file.name);
  const creds = extractOauthCreds(payload);
  if (!creds.accessToken && !creds.refreshToken) {
    throw new Error(`cliproxy Google auth file '${account.file.name}' is missing OAuth tokens`);
  }

  return {
    ...creds,
    source: "cliproxy",
    accountLabel: account.label,
  };
}

async function assertSupportedAuthType(): Promise<void> {
  const settings = await loadJsonFile<Record<string, unknown>>(SETTINGS_PATH);
  const authType = readString(settings?.authType)?.toLowerCase();

  if (!authType || authType === "oauth-personal") {
    return;
  }

  if (authType === "api-key") {
    throw new Error("Gemini auth type api-key is not supported by OpenUsage.");
  }

  if (authType === "vertex-ai") {
    throw new Error("Gemini auth type vertex-ai is not supported by OpenUsage.");
  }

  throw new Error(`Gemini unsupported auth type: ${authType}`);
}

async function loadOauthCredsFromFile(
  filePath: string,
): Promise<Omit<GoogleCredential, "source"> | undefined> {
  const parsed = await loadJsonFile<Record<string, unknown>>(filePath);
  return parsed ? extractOauthCreds(parsed) : undefined;
}

async function saveOauthCreds(credential: GoogleCredential): Promise<void> {
  if (credential.source !== "host" || !credential.persistPath) {
    return;
  }

  const current = (await loadJsonFile<Record<string, unknown>>(credential.persistPath)) ?? {};
  await writeFile(
    credential.persistPath,
    JSON.stringify(
      {
        ...current,
        access_token: credential.accessToken,
        refresh_token: credential.refreshToken,
        id_token: credential.idToken,
        expiry_date: credential.expiryDate,
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function refreshAccessToken(
  ctx: ExtensionContext,
  credential: GoogleCredential,
): Promise<string | undefined> {
  if (!credential.refreshToken) {
    return undefined;
  }

  const clientCreds =
    readOauthClientCredsFromCredential(credential) ?? (await loadOauthClientCreds());
  if (!clientCreds) {
    return undefined;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientCreds.clientId,
      client_secret: clientCreds.clientSecret,
      refresh_token: credential.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: ctx.signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("Gemini session expired. Run `gemini auth login`.");
  }

  if (!response.ok) {
    return undefined;
  }

  const body = (await response.json()) as Record<string, unknown>;
  const accessToken = readString(body.access_token);
  if (!accessToken) {
    return undefined;
  }

  credential.accessToken = accessToken;
  const idToken = readString(body.id_token);
  if (idToken) {
    credential.idToken = idToken;
  }

  const refreshToken = readString(body.refresh_token);
  if (refreshToken) {
    credential.refreshToken = refreshToken;
  }

  const expiresIn = readNumber(body.expires_in);
  if (expiresIn !== undefined) {
    credential.expiryDate = Date.now() + expiresIn * 1000;
  }

  await saveOauthCreds(credential);
  return accessToken;
}

async function fetchLoadCodeAssist(
  ctx: ExtensionContext,
  credential: GoogleCredential,
): Promise<LoadCodeAssistResult> {
  let currentToken = credential.accessToken;
  if (!currentToken && credential.refreshToken) {
    currentToken = await refreshAccessToken(ctx, credential);
  }

  if (!currentToken) {
    throw new Error(
      "Gemini auth unavailable. Run `gemini auth login` or choose a cliproxy account.",
    );
  }

  let response = await postJson(ctx, LOAD_CODE_ASSIST_URL, currentToken, {
    metadata: IDE_METADATA,
  });

  if ((response.status === 401 || response.status === 403) && credential.refreshToken) {
    const refreshed = await refreshAccessToken(ctx, credential);
    if (refreshed) {
      currentToken = refreshed;
      response = await postJson(ctx, LOAD_CODE_ASSIST_URL, currentToken, {
        metadata: IDE_METADATA,
      });
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Gemini session expired. Run `gemini auth login`.");
  }

  if (!response.ok) {
    return { data: undefined, accessToken: currentToken };
  }

  return {
    data: (await response.json()) as unknown,
    accessToken: currentToken,
  };
}

async function fetchQuota(
  ctx: ExtensionContext,
  credential: GoogleCredential,
  projectId: string | undefined,
): Promise<Response> {
  let currentToken = credential.accessToken;
  if (!currentToken && credential.refreshToken) {
    currentToken = await refreshAccessToken(ctx, credential);
  }

  if (!currentToken) {
    throw new Error(
      "Gemini auth unavailable. Run `gemini auth login` or choose a cliproxy account.",
    );
  }

  let response = await postJson(
    ctx,
    QUOTA_URL,
    currentToken,
    projectId ? { project: projectId } : {},
  );

  if ((response.status === 401 || response.status === 403) && credential.refreshToken) {
    const refreshed = await refreshAccessToken(ctx, credential);
    if (refreshed) {
      currentToken = refreshed;
      response = await postJson(
        ctx,
        QUOTA_URL,
        currentToken,
        projectId ? { project: projectId } : {},
      );
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Gemini session expired. Run `gemini auth login`.");
  }

  if (!response.ok) {
    throw new Error(`Gemini quota failed: ${response.status} ${response.statusText}`);
  }

  credential.accessToken = currentToken;
  return response;
}

async function postJson(
  ctx: ExtensionContext,
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
}

async function discoverProjectId(
  ctx: ExtensionContext,
  accessToken: string,
  loadCodeAssistData: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const projectId = readProjectId(loadCodeAssistData);
  if (projectId) {
    return projectId;
  }

  try {
    const response = await fetch(PROJECTS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: ctx.signal,
    });

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as Record<string, unknown>;
    const projects = Array.isArray(body.projects) ? body.projects : [];
    for (const entry of projects) {
      const project = asRecord(entry);
      const currentProjectId = readString(project?.projectId);
      if (!currentProjectId) {
        continue;
      }

      if (currentProjectId.startsWith("gen-lang-client")) {
        return currentProjectId;
      }

      const labels = asRecord(project?.labels);
      if (labels && Object.hasOwn(labels, "generative-language")) {
        return currentProjectId;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function readProjectId(
  loadCodeAssistData: Record<string, unknown> | undefined,
): string | undefined {
  const direct = loadCodeAssistData?.cloudaicompanionProject;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const nested = readString((direct as Record<string, unknown>).id);
    if (nested) {
      return nested;
    }
  }

  return readFirstStringDeep(loadCodeAssistData, ["cloudaicompanionProject"]);
}

function filterBuckets(buckets: QuotaBucket[], pool: "pro" | "flash"): QuotaBucket[] {
  return buckets.filter((bucket) => {
    const modelId = bucket.modelId.toLowerCase();
    return modelId.includes("gemini") && modelId.includes(pool);
  });
}

function collectQuotaBuckets(value: unknown): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  collectQuotaBucketsInto(value, buckets);
  return buckets;
}

function collectQuotaBucketsInto(value: unknown, buckets: QuotaBucket[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectQuotaBucketsInto(item, buckets);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const remainingFraction = readNumber(record.remainingFraction);
  if (remainingFraction !== undefined) {
    buckets.push({
      modelId: readString(record.modelId) ?? readString(record.model_id) ?? "unknown",
      remainingFraction,
      resetTime: readString(record.resetTime) ?? readString(record.reset_time) ?? undefined,
    });
  }

  for (const nested of Object.values(record)) {
    collectQuotaBucketsInto(nested, buckets);
  }
}

function pickLowestRemainingBucket(buckets: QuotaBucket[]): QuotaBucket | undefined {
  let best: QuotaBucket | undefined;

  for (const bucket of buckets) {
    if (!Number.isFinite(bucket.remainingFraction)) {
      continue;
    }

    if (!best || bucket.remainingFraction < best.remainingFraction) {
      best = bucket;
    }
  }

  return best;
}

function buildSummary(
  proBucket: QuotaBucket | undefined,
  flashBucket: QuotaBucket | undefined,
): string | undefined {
  const parts: string[] = [];

  const proSummary = formatBucketSummary("Pro", proBucket);
  if (proSummary) {
    parts.push(proSummary);
  }

  const flashSummary = formatBucketSummary("Flash", flashBucket);
  if (flashSummary) {
    parts.push(flashSummary);
  }

  return parts.length > 0 ? parts.join(" · ") : "no Gemini quota data in response";
}

function formatBucketSummary(label: string, bucket: QuotaBucket | undefined): string | undefined {
  if (!bucket) {
    return undefined;
  }

  const remaining = clampPercent(clampFraction(bucket.remainingFraction) * 100);
  return `${label} ${formatPercent(remaining)} left`;
}

function mapTierToPlan(
  tier: string | undefined,
  idTokenPayload: Record<string, unknown> | undefined,
): string | undefined {
  const normalizedTier = tier?.trim().toLowerCase();
  if (!normalizedTier) {
    return undefined;
  }

  if (normalizedTier === "standard-tier") {
    return "Paid";
  }

  if (normalizedTier === "legacy-tier") {
    return "Legacy";
  }

  if (normalizedTier === "free-tier") {
    return readString(idTokenPayload?.hd) ? "Workspace" : "Free";
  }

  return undefined;
}

function extractAccountLabel(
  idTokenPayload: Record<string, unknown> | undefined,
  loadCodeAssistData: Record<string, unknown> | undefined,
): string | undefined {
  return (
    readString(idTokenPayload?.email) ??
    readFirstStringDeep(loadCodeAssistData, ["email", "userEmail"])
  );
}

function readOauthClientCredsFromCredential(
  credential: GoogleCredential,
): OauthClientCreds | undefined {
  const clientId = credential.clientId?.trim();
  const clientSecret = credential.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    return undefined;
  }

  return { clientId, clientSecret };
}

async function loadOauthClientCreds(): Promise<OauthClientCreds | undefined> {
  for (const filePath of OAUTH2_JS_PATHS) {
    try {
      const parsed = parseOauthClientCreds(await readFile(filePath, "utf8"));
      if (parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function parseOauthClientCreds(text: string): OauthClientCreds | undefined {
  const clientIdMatch = text.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
  const clientSecretMatch = text.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/);
  if (!clientIdMatch || !clientSecretMatch) {
    return undefined;
  }

  return {
    clientId: clientIdMatch[1],
    clientSecret: clientSecretMatch[1],
  };
}

function extractOauthCreds(payload: unknown): Omit<GoogleCredential, "source"> {
  return {
    accessToken: readDeepString(payload, [
      ["access_token"],
      ["accessToken"],
      ["token"],
      ["token", "access_token"],
      ["token", "accessToken"],
      ["tokens", "access_token"],
      ["tokens", "accessToken"],
      ["credentials", "access_token"],
      ["credentials", "accessToken"],
      ["google", "access_token"],
      ["google", "accessToken"],
      ["gemini", "access_token"],
      ["gemini", "accessToken"],
      ["oauth", "access_token"],
      ["oauth", "accessToken"],
      ["data", "access_token"],
      ["data", "accessToken"],
    ]),
    refreshToken: readDeepString(payload, [
      ["refresh_token"],
      ["refreshToken"],
      ["token", "refresh_token"],
      ["token", "refreshToken"],
      ["tokens", "refresh_token"],
      ["tokens", "refreshToken"],
      ["credentials", "refresh_token"],
      ["credentials", "refreshToken"],
      ["google", "refresh_token"],
      ["google", "refreshToken"],
      ["gemini", "refresh_token"],
      ["gemini", "refreshToken"],
      ["oauth", "refresh_token"],
      ["oauth", "refreshToken"],
      ["data", "refresh_token"],
      ["data", "refreshToken"],
    ]),
    idToken: readDeepString(payload, [
      ["id_token"],
      ["idToken"],
      ["token", "id_token"],
      ["token", "idToken"],
      ["tokens", "id_token"],
      ["tokens", "idToken"],
      ["credentials", "id_token"],
      ["credentials", "idToken"],
      ["google", "id_token"],
      ["google", "idToken"],
      ["gemini", "id_token"],
      ["gemini", "idToken"],
      ["oauth", "id_token"],
      ["oauth", "idToken"],
      ["data", "id_token"],
      ["data", "idToken"],
    ]),
    expiryDate:
      readDeepNumber(payload, [
        ["expiry_date"],
        ["expiryDate"],
        ["expires_at"],
        ["expiresAt"],
        ["expiry"],
        ["token", "expiry_date"],
        ["token", "expiryDate"],
        ["token", "expires_at"],
        ["token", "expiresAt"],
        ["token", "expiry"],
        ["tokens", "expiry_date"],
        ["tokens", "expiryDate"],
        ["credentials", "expiry_date"],
        ["credentials", "expiryDate"],
        ["google", "expiry_date"],
        ["google", "expiryDate"],
        ["gemini", "expiry_date"],
        ["gemini", "expiryDate"],
        ["oauth", "expiry_date"],
        ["oauth", "expiryDate"],
        ["data", "expiry_date"],
        ["data", "expiryDate"],
      ]) ??
      readDeepString(payload, [
        ["expiry_date"],
        ["expiryDate"],
        ["expires_at"],
        ["expiresAt"],
        ["expiry"],
        ["token", "expiry_date"],
        ["token", "expiryDate"],
        ["token", "expires_at"],
        ["token", "expiresAt"],
        ["token", "expiry"],
      ]),
    clientId: readDeepString(payload, [
      ["client_id"],
      ["clientId"],
      ["token", "client_id"],
      ["token", "clientId"],
      ["credentials", "client_id"],
      ["credentials", "clientId"],
      ["google", "client_id"],
      ["google", "clientId"],
      ["gemini", "client_id"],
      ["gemini", "clientId"],
      ["oauth", "client_id"],
      ["oauth", "clientId"],
      ["data", "client_id"],
      ["data", "clientId"],
    ]),
    clientSecret: readDeepString(payload, [
      ["client_secret"],
      ["clientSecret"],
      ["token", "client_secret"],
      ["token", "clientSecret"],
      ["credentials", "client_secret"],
      ["credentials", "clientSecret"],
      ["google", "client_secret"],
      ["google", "clientSecret"],
      ["gemini", "client_secret"],
      ["gemini", "clientSecret"],
      ["oauth", "client_secret"],
      ["oauth", "clientSecret"],
      ["data", "client_secret"],
      ["data", "clientSecret"],
    ]),
  };
}

async function loadJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function readFirstStringDeep(
  value: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!value) {
    return undefined;
  }

  for (const key of keys) {
    const current = readString(value[key]);
    if (current) {
      return current;
    }
  }

  for (const nested of Object.values(value)) {
    const found = readFirstStringDeep(asRecord(nested), keys);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function readDeepString(value: unknown, paths: string[][]): string | undefined {
  for (const pathKeys of paths) {
    let current: unknown = value;
    for (const key of pathKeys) {
      const record = asRecord(current);
      if (!record) {
        current = undefined;
        break;
      }
      current = record[key];
    }

    const found = readString(current);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function readDeepNumber(value: unknown, paths: string[][]): number | undefined {
  for (const pathKeys of paths) {
    let current: unknown = value;
    for (const key of pathKeys) {
      const record = asRecord(current);
      if (!record) {
        current = undefined;
        break;
      }
      current = record[key];
    }

    const found = readNumber(current);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }

  try {
    const parts = token.split(".");
    if (parts.length < 2) {
      return undefined;
    }

    return asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function toIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function joinSummary(...values: Array<string | undefined>): string | undefined {
  const parts = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session expired|auth unavailable|401|403/i.test(message);
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
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
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
