import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WebSocket, type RawData } from "ws";
import { isUnknownRecord, parseUnknownJson, readUnknownString } from "../../utils/unknown-value.js";
import { downloadCliproxyAuthFile, listCliproxyAccounts } from "../openusage/cliproxy.js";
import { restorePersistedState } from "../openusage/state.js";
import type { CliproxyAccountsByProvider } from "../openusage/types.js";
import {
  buildLiveSessionPayload,
  parseLiveServerEvent,
  type LiveClientMessage,
  type LiveServerEvent,
} from "./protocol.js";

const SIGNALING_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const CODEX_CLIENT_VERSION = "0.144.1";
const LIVE_PROVIDER = "openai-codex";
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/u;
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

interface CodexAccess {
  accessToken: string;
  accountId?: string;
  providerHeaders: Record<string, string>;
}

interface LiveSignalingResult {
  answer: string;
  callId: string;
  access: CodexAccess;
}

export interface CodexLiveControlOptions {
  context: ExtensionContext;
  sessionId: string;
  instructions: string;
  voice: string;
  onEvent(event: LiveServerEvent): void;
  signal?: AbortSignal;
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function extractCodexAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[1] === undefined || parts[1].length === 0) return undefined;
    const payload = parseUnknownJson(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isUnknownRecord(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isUnknownRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the server-assigned call ID.
 *
 * @param {string | null} location Signaling Location header.
 * @returns {string | undefined} Valid call ID when present.
 */
export function parseLiveCallId(location: string | null): string | undefined {
  if (location === null || location.length === 0) return undefined;
  return location
    .split("?", 1)[0]
    ?.split("/")
    .find((segment) => LIVE_CALL_ID_PATTERN.test(segment));
}

/**
 * Builds the Frameless Bidi sideband URL.
 *
 * @param {string} callId Accepted Codex call ID.
 * @returns {string} Sideband WebSocket URL.
 */
export function buildLiveSidebandUrl(callId: string): string {
  return `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`;
}

function boundedErrorBody(body: string, statusText: string): string {
  const normalized = body.trim().replaceAll(/\s+/gu, " ");
  if (normalized.length === 0) return statusText.length > 0 ? statusText : "empty response body";
  if (normalized.length <= MAX_ERROR_BODY_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Live connection aborted", "AbortError");
}

function liveSessionHeaders(
  access: CodexAccess,
  sessionId: string,
  realtimeSessionId: string,
): Record<string, string> {
  return {
    ...access.providerHeaders,
    Authorization: `Bearer ${access.accessToken}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
    "x-session-id": realtimeSessionId,
    originator: LIVE_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    "session-id": sessionId,
    "thread-id": sessionId,
    ...(access.accountId !== undefined && access.accountId.length > 0
      ? { "chatgpt-account-id": access.accountId }
      : {}),
  };
}

async function resolveCodexAccess(context: ExtensionContext): Promise<CodexAccess> {
  const result = await context.modelRegistry.getProviderAuth(LIVE_PROVIDER);
  const accessToken =
    result?.auth.apiKey ?? (await context.modelRegistry.getApiKeyForProvider(LIVE_PROVIDER));
  if (accessToken !== undefined && accessToken.length > 0) {
    return {
      accessToken,
      accountId: extractCodexAccountId(accessToken),
      providerHeaders: Object.fromEntries(
        Object.entries(result?.auth.headers ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
  }

  const persisted = restorePersistedState(context.sessionManager.getBranch());
  const accountGroups = await listCliproxyAccounts(context).catch(
    (): CliproxyAccountsByProvider => ({}),
  );
  const accounts = accountGroups.codex ?? [];
  const selected = persisted.selectedAccounts.codex?.trim();
  const selectedAccount =
    selected !== undefined && selected.length > 0
      ? accounts.find((candidate) => candidate.value === selected)
      : undefined;
  const account = selectedAccount ?? accounts[0];
  if (account === undefined) {
    throw new Error(
      "Codex OAuth is unavailable. Run /login openai-codex or configure a CLIProxyAPI Codex account.",
    );
  }
  const payload = await downloadCliproxyAuthFile(context, account.file.name);
  const credential = readCliproxyCodexCredential(payload);
  return {
    accessToken: credential.accessToken,
    accountId: credential.accountId ?? extractCodexAccountId(credential.accessToken),
    providerHeaders: {},
  };
}

function readCliproxyCodexCredential(payload: unknown): {
  accessToken: string;
  accountId?: string;
} {
  const root = isUnknownRecord(payload) ? payload : undefined;
  const tokens = isUnknownRecord(root?.tokens) ? root.tokens : undefined;
  const accessToken =
    readUnknownString(root?.access_token) ??
    readUnknownString(root?.accessToken) ??
    readUnknownString(tokens?.access_token) ??
    readUnknownString(tokens?.accessToken);
  const accountId =
    readUnknownString(root?.account_id) ??
    readUnknownString(root?.accountId) ??
    readUnknownString(tokens?.account_id) ??
    readUnknownString(tokens?.accountId);
  if (accessToken === undefined) {
    throw new Error("CLIProxyAPI Codex auth file is missing access_token");
  }
  return { accessToken, accountId };
}

/**
 * Authenticated Codex control plane. The WebRTC media peer lives in the macOS app; this class only
 * performs SDP signaling and owns the sideband socket.
 */
export class CodexLiveControl {
  readonly #options: CodexLiveControlOptions;
  readonly #realtimeSessionId = crypto.randomUUID();
  #sideband: WebSocket | undefined;
  #state: Lifecycle = "idle";
  #connectPromise: Promise<string> | undefined;
  #closePromise: Promise<void> | undefined;
  #sendTail: Promise<void> = Promise.resolve();
  #unexpectedFailureReported = false;

  constructor(options: CodexLiveControlOptions) {
    this.#options = options;
  }

  connect(offer: string): Promise<string> {
    if (this.#state === "connected") return Promise.reject(new Error("Live control is connected"));
    if (this.#connectPromise !== undefined) return this.#connectPromise;
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(new Error("Live control is closed"));
    }
    this.#state = "connecting";
    this.#connectPromise = this.#connect(offer).catch(async (error) => {
      await this.close();
      throw error;
    });
    return this.#connectPromise;
  }

  async #connect(offer: string): Promise<string> {
    if (this.#options.signal?.aborted === true) throw abortReason(this.#options.signal);
    const signaling = await this.#signal(offer);
    await this.#connectSideband(signaling.callId, signaling.access);
    if (this.#state !== "connecting") throw abortReason(this.#options.signal);
    this.#state = "connected";
    return signaling.answer;
  }

  async #signal(offer: string): Promise<LiveSignalingResult> {
    const access = await resolveCodexAccess(this.#options.context);
    const headers = new Headers({
      ...liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId),
      Accept: "*/*",
      "Content-Type": "application/json",
    });
    const response = await fetch(SIGNALING_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sdp: offer,
        session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice),
      }),
      signal: this.#options.signal,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      const detail = boundedErrorBody(responseBody, response.statusText);
      throw new Error(`Codex live signaling failed (${response.status}): ${detail}`);
    }
    if (responseBody.trim().length === 0) {
      throw new Error("Codex live signaling returned an empty SDP answer");
    }
    const callId = parseLiveCallId(response.headers.get("location"));
    if (callId === undefined) throw new Error("Codex live signaling returned no valid call ID");
    return { answer: responseBody, callId, access };
  }

  async #connectSideband(callId: string, access: CodexAccess): Promise<void> {
    let failure = new Error("Codex live sideband connection failed");
    for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt += 1) {
      try {
        await this.#openSideband(callId, access);
        return;
      } catch (cause) {
        failure = errorFrom(cause);
        if (this.#options.signal?.aborted === true) throw abortReason(this.#options.signal);
        if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await sleep(200 * 2 ** attempt);
      }
    }
    throw failure;
  }

  async #openSideband(callId: string, access: CodexAccess): Promise<void> {
    const socket = new WebSocket(buildLiveSidebandUrl(callId), {
      headers: liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId),
    });
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let opened = false;
    let settled = false;
    const rejectUnsettled = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timeout = setTimeout(() => {
      socket.close(1000, "connect timeout");
      rejectUnsettled(new Error("Codex live sideband connection timed out"));
    }, SIDEBAND_CONNECT_TIMEOUT_MS);
    timeout.unref?.();
    const onAbort = (): void => {
      socket.close(1000, "aborted");
      rejectUnsettled(abortReason(this.#options.signal));
    };
    this.#options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("open", () => {
      if (settled) return;
      opened = true;
      settled = true;
      clearTimeout(timeout);
      this.#options.signal?.removeEventListener("abort", onAbort);
      this.#sideband = socket;
      resolve();
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.#handleSidebandEvent(rawDataText(data));
    });
    socket.on("error", (cause) => {
      const error = errorFrom(cause);
      if (opened || settled) {
        this.#reportFailure(`Codex live sideband failed: ${error.message}`);
      } else {
        clearTimeout(timeout);
        rejectUnsettled(error);
      }
    });
    socket.on("close", (code, reason) => {
      if (opened || settled) {
        if (this.#sideband !== socket) return;
        this.#sideband = undefined;
        if (this.#state === "connecting" || this.#state === "connected") {
          this.#reportFailure(
            `Codex live sideband closed (${code})${reason.length > 0 ? `: ${reason.toString("utf8")}` : ""}`,
          );
        }
      } else {
        clearTimeout(timeout);
        rejectUnsettled(new Error(`Codex live sideband closed before connecting (${code})`));
      }
    });
    await promise;
  }

  #handleSidebandEvent(payload: string): void {
    if (this.#state === "closing" || this.#state === "closed") return;
    const event = parseLiveServerEvent(payload);
    if (event === null) return;
    try {
      this.#options.onEvent(event);
    } catch {}
  }

  #reportFailure(message: string): void {
    if (
      (this.#state !== "connecting" && this.#state !== "connected") ||
      this.#unexpectedFailureReported
    ) {
      return;
    }
    this.#unexpectedFailureReported = true;
    try {
      this.#options.onEvent({ type: "error", message });
    } catch {}
  }

  send(message: LiveClientMessage): Promise<void> {
    const operation = this.#sendTail.then(() => {
      if (this.#state !== "connected") throw new Error("Live control is not connected");
      const socket = this.#sideband;
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Codex live sideband is not connected");
      }
      socket.send(JSON.stringify(message));
    });
    this.#sendTail = operation.catch(() => {});
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = "closing";
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    await this.#sendTail;
    const socket = this.#sideband;
    this.#sideband = undefined;
    if (
      socket !== undefined &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close(1000, "done");
    }
    this.#state = "closed";
  }
}
