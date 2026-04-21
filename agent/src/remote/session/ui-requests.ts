import { randomUUID } from "node:crypto";
import type { UiResponseRequest, ExtensionUiRequestEventPayload } from "../schemas.js";
import type { SessionRecord } from "./types.js";

type UiRequestInput<T> = {
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  defaultValue: T;
  parse: (response: UiResponseRequest) => T;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  signal?: AbortSignal;
};

type UiRequestEnvironment = {
  now: () => number;
  publishUiEvent: (record: SessionRecord, payload: ExtensionUiRequestEventPayload) => void;
};

export function requestRemoteUiValue<T>(
  record: SessionRecord,
  input: UiRequestInput<T>,
  environment: UiRequestEnvironment,
): Promise<T> {
  if (input.signal?.aborted === true) {
    return Promise.resolve(input.defaultValue);
  }

  const id = randomUUID();
  return createRemoteUiRequestPromise(record, id, input, environment);
}

function createRemoteUiRequestPromise<T>(
  record: SessionRecord,
  id: string,
  input: UiRequestInput<T>,
  environment: UiRequestEnvironment,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const finish = (response: UiResponseRequest): void => {
      if (done) {
        return;
      }
      done = true;
      completeRemoteUiRequest(record, id, timeoutHandle, input.signal, onAbort, environment.now);
      resolve(input.parse(response));
    };
    const onAbort = (): void => {
      finish({ id, cancelled: true });
    };

    input.signal?.addEventListener("abort", onAbort, { once: true });
    timeoutHandle = startRemoteUiRequestTimeout(id, input.timeout, finish);
    registerPendingRemoteUiRequest(record, id, finish, environment.now);
    environment.publishUiEvent(record, buildRemoteUiRequestPayload(id, input));
  });
}

function completeRemoteUiRequest(
  record: SessionRecord,
  requestId: string,
  timeoutHandle: NodeJS.Timeout | undefined,
  signal: AbortSignal | undefined,
  onAbort: () => void,
  now: () => number,
): void {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  signal?.removeEventListener("abort", onAbort);
  record.pendingUiRequests.delete(requestId);
  if (record.activeRun?.pendingUiRequestId === requestId) {
    record.activeRun.pendingUiRequestId = undefined;
    record.activeRun.updatedAt = now();
  }
}

function startRemoteUiRequestTimeout(
  requestId: string,
  timeout: number | undefined,
  finish: (response: UiResponseRequest) => void,
): NodeJS.Timeout | undefined {
  if (typeof timeout !== "number" || timeout <= 0) {
    return undefined;
  }

  return setTimeout(() => {
    finish({ id: requestId, cancelled: true });
  }, timeout);
}

function registerPendingRemoteUiRequest(
  record: SessionRecord,
  requestId: string,
  finish: (response: UiResponseRequest) => void,
  now: () => number,
): void {
  record.pendingUiRequests.set(requestId, { resolve: finish });
  if (record.activeRun) {
    record.activeRun.pendingUiRequestId = requestId;
    record.activeRun.updatedAt = now();
  }
}

function buildRemoteUiRequestPayload<T>(
  id: string,
  input: UiRequestInput<T>,
): ExtensionUiRequestEventPayload {
  const timeoutPayload = buildRemoteUiRequestTimeoutPayload(input.timeout);
  if (input.method === "select") {
    return {
      id,
      method: "select",
      title: input.title,
      options: input.options ?? [],
      ...timeoutPayload,
    };
  }

  if (input.method === "confirm") {
    return {
      id,
      method: "confirm",
      title: input.title,
      message: input.message ?? "",
      ...timeoutPayload,
    };
  }

  if (input.method === "input") {
    return {
      id,
      method: "input",
      title: input.title,
      ...(input.placeholder !== undefined && input.placeholder.length > 0
        ? { placeholder: input.placeholder }
        : {}),
      ...timeoutPayload,
    };
  }

  return {
    id,
    method: "editor",
    title: input.title,
    ...(input.prefill !== undefined && input.prefill.length > 0 ? { prefill: input.prefill } : {}),
    ...timeoutPayload,
  };
}

function buildRemoteUiRequestTimeoutPayload(timeout: number | undefined): { timeout?: number } {
  if (typeof timeout !== "number" || timeout <= 0) {
    return {};
  }

  return { timeout };
}
