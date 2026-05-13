import { AuthStorage, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  ctx?: Pick<ExtensionContext, "modelRegistry">,
): Promise<string | undefined> {
  if (ctx !== undefined) {
    return ctx.modelRegistry.authStorage.getApiKey(NOTIFY_AUTH_PROVIDER, {
      includeFallback: false,
    });
  }
  return AuthStorage.create().getApiKey(NOTIFY_AUTH_PROVIDER, { includeFallback: false });
}
