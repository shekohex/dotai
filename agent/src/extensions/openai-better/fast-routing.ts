import type { ProviderHeaders } from "@earendil-works/pi-ai";

export const CODEX_FAST_ORIGINATOR = "codex_cli_rs";
export const CODEX_NORMAL_ORIGINATOR = "pi";
export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";

const CODEX_PROVIDERS = new Set(["codex-openai", "openai-codex"]);
const activeFastSessions = new Set<string>();

function deleteHeader(headers: ProviderHeaders, name: string): void {
  const normalizedName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalizedName) delete headers[key];
  }
}

export function applyCodexFastHeaders(
  headers: ProviderHeaders,
  modelId: string,
  fastModeActive: boolean,
): ProviderHeaders {
  deleteHeader(headers, "originator");
  deleteHeader(headers, CODEX_ROUTING_HINT_HEADER);
  headers.originator = fastModeActive ? CODEX_FAST_ORIGINATOR : CODEX_NORMAL_ORIGINATOR;
  if (fastModeActive) {
    headers[CODEX_ROUTING_HINT_HEADER] = `model=${modelId};tier=priority`;
  }
  return headers;
}

export function isCodexProvider(provider: string | undefined): boolean {
  return provider !== undefined && CODEX_PROVIDERS.has(provider);
}

export function setSessionFastModeActive(sessionId: string, active: boolean): void {
  if (active) activeFastSessions.add(sessionId);
  else activeFastSessions.delete(sessionId);
}

export function isSessionFastModeActive(sessionId: string | undefined): boolean {
  return sessionId !== undefined && activeFastSessions.has(sessionId);
}

export function clearSessionFastMode(sessionId?: string): void {
  if (sessionId === undefined) activeFastSessions.clear();
  else activeFastSessions.delete(sessionId);
}
