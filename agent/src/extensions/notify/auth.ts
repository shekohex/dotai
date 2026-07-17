import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveStoredApiKey } from "../../utils/stored-credential.js";
import { NOTIFY_AUTH_PROVIDER } from "./types.js";

export interface NotifyAuthHeadersResult {
  configured: boolean;
  mode: "anonymous" | "bearer" | "basic";
  headers: Record<string, string>;
  label: string;
}

function createBasicHeader(rawCredential: string): string {
  return `Basic ${Buffer.from(rawCredential, "utf8").toString("base64")}`;
}

function looksLikeAccessToken(value: string): boolean {
  return value.startsWith("tk_");
}

export function createNotifyAuthHeaders(
  credential: string | undefined,
  allowAnonymous: boolean,
): NotifyAuthHeadersResult {
  const trimmed = credential?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return {
      configured: false,
      mode: "anonymous",
      headers: {},
      label: allowAnonymous ? "anonymous" : "missing",
    };
  }

  if (trimmed.includes(":") && !looksLikeAccessToken(trimmed)) {
    return {
      configured: true,
      mode: "basic",
      headers: { Authorization: createBasicHeader(trimmed) },
      label: "basic",
    };
  }

  return {
    configured: true,
    mode: "bearer",
    headers: { Authorization: `Bearer ${trimmed}` },
    label: "bearer",
  };
}

export function resolveNotifyCredential(
  _ctx?: Pick<ExtensionContext, "modelRegistry">,
): Promise<string | undefined> {
  return Promise.resolve(resolveStoredApiKey(NOTIFY_AUTH_PROVIDER));
}
