import { randomUUID } from "node:crypto";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SessionStatus } from "../schemas.js";
import { RemoteError } from "../errors.js";
import type { AcceptedSessionCommand, SessionRecord } from "./types.js";

const ModelRefSchema = Type.Object({
  provider: Type.String(),
  id: Type.String(),
});

type PromptPreflightSession = {
  model: unknown;
  modelRegistry: {
    find: (provider: string, modelId: string) => unknown;
    getApiKeyAndHeaders: (model: Model<Api>) => Promise<{
      ok: boolean;
      error?: string;
      apiKey?: string;
    }>;
    isUsingOAuth: (model: Model<Api>) => boolean;
  };
};

function readModelRef(value: unknown): { provider: string; id: string } | undefined {
  if (!Value.Check(ModelRefSchema, value)) {
    return undefined;
  }
  return Value.Parse(ModelRefSchema, value);
}

function resolvePromptPreflightModel(input: {
  session: PromptPreflightSession;
  isApiModel: (value: unknown) => value is Model<Api>;
}): Model<Api> {
  const modelRef = readModelRef(input.session.model);
  if (!modelRef) {
    throw new RemoteError("No model selected", 400);
  }

  const resolved = input.session.modelRegistry.find(modelRef.provider, modelRef.id);
  if (input.isApiModel(resolved)) {
    return resolved;
  }
  if (input.isApiModel(input.session.model)) {
    return input.session.model;
  }
  throw new RemoteError("No model selected", 400);
}

export async function ensurePromptPreflight(input: {
  session: PromptPreflightSession;
  isApiModel: (value: unknown) => value is Model<Api>;
}): Promise<void> {
  const model = resolvePromptPreflightModel(input);

  const requestAuth = await input.session.modelRegistry.getApiKeyAndHeaders(model);
  if (!requestAuth.ok) {
    throw new RemoteError(requestAuth.error ?? "Authentication failed", 400);
  }
  if (requestAuth.apiKey !== undefined && requestAuth.apiKey.length > 0) {
    return;
  }
  if (input.session.modelRegistry.isUsingOAuth(model)) {
    throw new RemoteError(
      `Authentication failed for "${model.provider}". Credentials may have expired or network is unavailable. Run '/login ${model.provider}' to re-authenticate.`,
      400,
    );
  }

  throw new RemoteError(`No API key found for ${model.provider}`, 400);
}

export function dispatchRuntimeCommand(input: {
  record: SessionRecord;
  command: AcceptedSessionCommand;
  operation: () => Promise<void>;
  syncFromRuntime: (record: SessionRecord, options?: { updateTimestamp?: boolean }) => void;
  getRuntimeSession: (record: SessionRecord) => { isStreaming: boolean } | undefined;
  now: () => number;
  appendExtensionError: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    message: string,
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): void {
  input.record.runtimeUndispatchedCommandCount += 1;

  const dispatch = () => dispatchRuntimeCommandOperation(input);
  const pending = input.record.runtimeDispatchQueue.then(dispatch, dispatch);
  input.record.runtimeDispatchQueue = pending.then(
    () => {},
    () => {},
  );
}

async function dispatchRuntimeCommandOperation(input: {
  record: SessionRecord;
  command: AcceptedSessionCommand;
  operation: () => Promise<void>;
  syncFromRuntime: (record: SessionRecord, options?: { updateTimestamp?: boolean }) => void;
  getRuntimeSession: (record: SessionRecord) => { isStreaming: boolean } | undefined;
  now: () => number;
  appendExtensionError: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    message: string,
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): Promise<void> {
  if (input.record.runtimeUndispatchedCommandCount > 0) {
    input.record.runtimeUndispatchedCommandCount -= 1;
  }
  markRuntimeCommandStart(input.record, input.command, input.now);

  const completion = runRuntimeCommandOperation(input);
  if (input.command.kind === "prompt") {
    await waitForPromptDispatchStart(input.record, completion, input.getRuntimeSession);
    return;
  }

  await completion;
}

function markRuntimeCommandStart(
  record: SessionRecord,
  command: AcceptedSessionCommand,
  now: () => number,
): void {
  const startedAt = now();
  record.updatedAt = startedAt;
  record.hasLocalCommandError = false;
  if (!record.activeRun && command.kind === "prompt") {
    record.activeRun = {
      runId: randomUUID(),
      status: "running" as SessionStatus,
      triggeringCommandId: command.commandId,
      startedAt,
      updatedAt: startedAt,
      queueDepth: record.queue.depth,
    };
  }
}

function runRuntimeCommandOperation(input: {
  record: SessionRecord;
  command: AcceptedSessionCommand;
  operation: () => Promise<void>;
  syncFromRuntime: (record: SessionRecord, options?: { updateTimestamp?: boolean }) => void;
  now: () => number;
  appendExtensionError: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    message: string,
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): Promise<void> {
  let failed = false;
  return input
    .operation()
    .catch((error: unknown) => {
      failed = true;
      handleRuntimeCommandFailure(
        input.record,
        input.command,
        error,
        input.now,
        input.appendExtensionError,
        input.emitSessionSummaryUpdated,
      );
    })
    .finally(() => {
      if (!failed) {
        input.record.hasLocalCommandError = false;
      }
      input.syncFromRuntime(input.record, {
        updateTimestamp: !failed,
      });
    });
}

function handleRuntimeCommandFailure(
  record: SessionRecord,
  command: AcceptedSessionCommand,
  error: unknown,
  now: () => number,
  appendExtensionError: (
    record: SessionRecord,
    command: AcceptedSessionCommand,
    message: string,
  ) => void,
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void,
): void {
  const message = error instanceof Error ? error.message : "Command execution failed";
  record.errorMessage = message;
  record.status = "error";
  record.hasLocalCommandError = true;
  record.updatedAt = now();
  appendExtensionError(record, command, message);
  emitSessionSummaryUpdated(record, record.updatedAt);
}

async function waitForPromptDispatchStart(
  record: SessionRecord,
  completion: Promise<void>,
  getRuntimeSession: (record: SessionRecord) => { isStreaming: boolean } | undefined,
): Promise<void> {
  while (true) {
    const session = getRuntimeSession(record);
    if (!session || session.isStreaming) {
      return;
    }

    const state = await Promise.race<"tick" | "done">([
      completion.then(() => "done" as const),
      new Promise<"tick">((resolve) => {
        setImmediate(() => {
          resolve("tick");
        });
      }),
    ]);
    if (state === "done") {
      return;
    }
  }
}

export function parseThinkingLevelFromAllowedSet(
  allowed: Set<ThinkingLevel>,
  level: string | undefined,
): ThinkingLevel | undefined {
  if (level === undefined || level.length === 0) {
    return undefined;
  }
  for (const candidate of allowed) {
    if (candidate === level) {
      return candidate;
    }
  }
  throw new RemoteError(`Invalid thinkingLevel. Expected one of: ${[...allowed].join(", ")}`, 400);
}
