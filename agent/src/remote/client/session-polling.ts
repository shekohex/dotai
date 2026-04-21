import type { StreamEventEnvelope } from "../schemas.js";
import { isRecord } from "./session-shared.js";

type SessionEventsReadResult = {
  events: StreamEventEnvelope[];
  nextOffset: string;
  streamClosed: boolean;
};

type PollRemoteSessionEventsInput = {
  isClosed: () => boolean;
  getStreamOffset: () => string;
  setStreamOffset: (offset: string) => void;
  setActiveReadAbortController: (controller: AbortController | undefined) => void;
  readSessionEvents: (options: {
    offset: string;
    signal: AbortSignal;
    onEvent: (envelope: StreamEventEnvelope) => Promise<void>;
    onControl: (nextOffset: string) => void;
  }) => Promise<SessionEventsReadResult>;
  handleEnvelope: (envelope: StreamEventEnvelope) => Promise<void>;
  handleRemoteError: (message: string) => void;
  handleRemoteWarning: (message: string) => void;
  reauthenticate: () => Promise<void>;
};

const RETRY_DELAY_MS = 250;
const AUTH_RETRY_BASE_DELAY_MS = 500;
const AUTH_RETRY_MAX_DELAY_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryablePollingError(error: unknown): boolean {
  const status = readErrorStatus(error);

  if (status === undefined) {
    return error instanceof TypeError;
  }

  if (status >= 500) {
    return true;
  }

  return status === 408 || status === 425 || status === 429;
}

function readErrorStatus(error: unknown): number | undefined {
  const statusCandidate = isRecord(error) ? Reflect.get(error, "status") : undefined;
  return typeof statusCandidate === "number" ? statusCandidate : undefined;
}

function isAuthTokenInvalidError(error: unknown): boolean {
  return readErrorStatus(error) === 401;
}

function isAuthKeyDeniedError(error: unknown): boolean {
  const status = readErrorStatus(error);
  return status === 401 || status === 403;
}

function getBackoffDelayMs(attempt: number): number {
  const factor = 2 ** Math.max(0, attempt - 1);
  return Math.min(AUTH_RETRY_BASE_DELAY_MS * factor, AUTH_RETRY_MAX_DELAY_MS);
}

function formatError(error: unknown): string {
  const message = getErrorMessage(error);
  const status = readErrorStatus(error);
  if (status === undefined) {
    return message;
  }
  return `${message} (HTTP ${status})`;
}

async function recoverAuthentication(input: PollRemoteSessionEventsInput): Promise<boolean> {
  input.handleRemoteWarning("Remote auth token invalid or expired. Reconnecting...");
  let attempt = 0;

  while (!input.isClosed()) {
    try {
      await input.reauthenticate();
      input.handleRemoteWarning("Remote connection restored.");
      return true;
    } catch (error) {
      if (input.isClosed()) {
        return false;
      }
      if (isAuthKeyDeniedError(error)) {
        input.handleRemoteError(`Remote authentication denied: ${formatError(error)}`);
        return false;
      }
      if (!isRetryablePollingError(error)) {
        input.handleRemoteError(`Remote authentication refresh failed: ${formatError(error)}`);
        return false;
      }
      attempt += 1;
      await delay(getBackoffDelayMs(attempt));
    }
  }

  return false;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function pollRemoteSessionEvents(input: PollRemoteSessionEventsInput): Promise<void> {
  while (!input.isClosed()) {
    try {
      const activeController = new AbortController();
      input.setActiveReadAbortController(activeController);
      const read = await input.readSessionEvents({
        offset: input.getStreamOffset(),
        signal: activeController.signal,
        onEvent: async (envelope) => {
          await input.handleEnvelope(envelope);
        },
        onControl: (nextOffset) => {
          input.setStreamOffset(nextOffset);
        },
      });
      if (input.isClosed()) {
        return;
      }
      for (const envelope of read.events) {
        await input.handleEnvelope(envelope);
      }
      input.setStreamOffset(read.nextOffset);
      if (read.streamClosed) {
        return;
      }
      if (read.events.length === 0) {
        await delay(RETRY_DELAY_MS);
      }
    } catch (error) {
      if (input.isClosed()) {
        return;
      }
      if (isAuthTokenInvalidError(error)) {
        const recovered = await recoverAuthentication(input);
        if (recovered) {
          continue;
        }
        return;
      }
      if (!isRetryablePollingError(error)) {
        input.handleRemoteError(`Remote stream polling failed: ${getErrorMessage(error)}`);
        return;
      }
      await delay(RETRY_DELAY_MS);
    } finally {
      input.setActiveReadAbortController(undefined);
    }
  }
}
