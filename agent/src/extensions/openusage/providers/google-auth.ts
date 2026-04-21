import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { downloadCliproxyAuthFile, resolveCliproxySelectedAccount } from "../cliproxy.js";
import type { OpenUsageRuntimeState } from "../types.js";
import {
  ACCESS_TOKEN_PATHS,
  CLIENT_ID_PATHS,
  CLIENT_SECRET_PATHS,
  CREDS_PATH,
  EXPIRY_NUMBER_PATHS,
  EXPIRY_STRING_PATHS,
  ID_TOKEN_PATHS,
  OAUTH2_JS_PATHS,
  REFRESH_TOKEN_PATHS,
  SETTINGS_PATH,
  TOKEN_URL,
  type GoogleCredential,
  type OauthClientCreds,
} from "./google-constants.js";
import {
  asRecord,
  hasText,
  loadJsonFile,
  readDeepNumber,
  readDeepString,
  readNumber,
  readString,
} from "./google-helpers.js";

async function resolveGoogleCredential(
  ctx: ExtensionContext,
  state: OpenUsageRuntimeState,
): Promise<GoogleCredential> {
  const selectedCliproxyAccount = state.persisted.selectedAccounts.google?.trim();
  if (hasText(selectedCliproxyAccount)) {
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

  if (hostError !== undefined) {
    throw hostError instanceof Error
      ? hostError
      : new Error("Gemini auth unavailable. Run `gemini auth login` or choose a cliproxy account.");
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
  if (!hasText(creds.accessToken) && !hasText(creds.refreshToken)) {
    throw new Error(`cliproxy Google auth file '${account.file.name}' is missing OAuth tokens`);
  }

  return {
    ...creds,
    source: "cliproxy",
    accountLabel: account.label,
  };
}

async function assertSupportedAuthType(): Promise<void> {
  const settings = asRecord(await loadJsonFile(SETTINGS_PATH));
  const authType = readString(settings?.authType)?.toLowerCase();

  if (!hasText(authType) || authType === "oauth-personal") {
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
  const parsed = asRecord(await loadJsonFile(filePath));
  return parsed ? extractOauthCreds(parsed) : undefined;
}

async function saveOauthCreds(credential: GoogleCredential): Promise<void> {
  if (credential.source !== "host" || !hasText(credential.persistPath)) {
    return;
  }

  const current = asRecord(await loadJsonFile(credential.persistPath)) ?? {};
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
  if (!hasText(credential.refreshToken)) {
    return undefined;
  }

  const clientCreds =
    readOauthClientCredsFromCredential(credential) ?? (await loadOauthClientCreds());
  if (!clientCreds) {
    return undefined;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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

  const body = asRecord(await response.json());
  const accessToken = readString(body?.access_token);
  if (!body || !hasText(accessToken)) {
    return undefined;
  }

  applyRefreshedCredential(credential, body, accessToken);
  await saveOauthCreds(credential);
  return accessToken;
}

function readOauthClientCredsFromCredential(
  credential: GoogleCredential,
): OauthClientCreds | undefined {
  const clientId = credential.clientId?.trim();
  const clientSecret = credential.clientSecret?.trim();
  if (!hasText(clientId) || !hasText(clientSecret)) {
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
    accessToken: readDeepString(payload, ACCESS_TOKEN_PATHS),
    refreshToken: readDeepString(payload, REFRESH_TOKEN_PATHS),
    idToken: readDeepString(payload, ID_TOKEN_PATHS),
    expiryDate:
      readDeepNumber(payload, EXPIRY_NUMBER_PATHS) ?? readDeepString(payload, EXPIRY_STRING_PATHS),
    clientId: readDeepString(payload, CLIENT_ID_PATHS),
    clientSecret: readDeepString(payload, CLIENT_SECRET_PATHS),
  };
}

function applyRefreshedCredential(
  credential: GoogleCredential,
  body: Record<string, unknown>,
  accessToken: string,
): void {
  credential.accessToken = accessToken;
  const idToken = readString(body.id_token);
  if (hasText(idToken)) {
    credential.idToken = idToken;
  }
  const refreshToken = readString(body.refresh_token);
  if (hasText(refreshToken)) {
    credential.refreshToken = refreshToken;
  }
  const expiresIn = readNumber(body.expires_in);
  if (expiresIn !== undefined) {
    credential.expiryDate = Date.now() + expiresIn * 1000;
  }
}

export { refreshAccessToken, resolveCliproxyGoogleCredential, resolveGoogleCredential };
