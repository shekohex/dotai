import { homedir } from "node:os";
import path from "node:path";

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

const ACCESS_TOKEN_PATHS: string[][] = [
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
];

const REFRESH_TOKEN_PATHS: string[][] = [
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
];

const ID_TOKEN_PATHS: string[][] = [
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
];

const EXPIRY_NUMBER_PATHS: string[][] = [
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
];

const EXPIRY_STRING_PATHS: string[][] = [
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
];

const CLIENT_ID_PATHS: string[][] = [
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
];

const CLIENT_SECRET_PATHS: string[][] = [
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
];

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

export {
  ACCESS_TOKEN_PATHS,
  CLIENT_ID_PATHS,
  CLIENT_SECRET_PATHS,
  CREDS_PATH,
  EXPIRY_NUMBER_PATHS,
  EXPIRY_STRING_PATHS,
  ID_TOKEN_PATHS,
  IDE_METADATA,
  LOAD_CODE_ASSIST_URL,
  OAUTH2_JS_PATHS,
  PROJECTS_URL,
  QUOTA_URL,
  REFRESH_TOKEN_PATHS,
  SETTINGS_PATH,
  TOKEN_URL,
  TWENTY_FOUR_HOURS_MS,
};
export type { GoogleCredential, LoadCodeAssistResult, OauthClientCreds, QuotaBucket };
