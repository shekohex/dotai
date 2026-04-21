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
};

const RETRY_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryablePollingError(error: unknown): boolean {
  const statusCandidate = isRecord(error) ? Reflect.get(error, "status") : undefined;
  const status = typeof statusCandidate === "number" ? statusCandidate : undefined;

  if (status === undefined) {
    return error instanceof TypeError;
  }

  if (status >= 500) {
    return true;
  }

  return status === 408 || status === 425 || status === 429;
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
