import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { RemoteError } from "../errors.js";
import type { CommandAcceptedResponse, ModelUpdateRequest } from "../schemas.js";
import type { AuthSession } from "../auth.js";
import type { AcceptedSessionCommand, SessionRecord } from "./types.js";

function resolveModelUpdateTarget(input: {
  record: SessionRecord;
  session: AgentSessionRuntime["session"];
  modelRef: string;
  parseModelRef: (model: string) => { provider: string; modelId: string } | null;
}): Model<Api> | undefined {
  const parsed = input.parseModelRef(input.modelRef);
  if (!parsed) {
    throw new RemoteError("Model must use provider/model format", 400);
  }

  const model = input.session.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model && input.modelRef !== input.record.model) {
    throw new RemoteError("Model not found", 400);
  }
  return model;
}

async function applyModelUpdateBeforeAccepted(input: {
  inputModel: string;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  record: SessionRecord;
  session: AgentSessionRuntime["session"];
}): Promise<void> {
  if (input.model) {
    await input.session.setModel(input.model);
    input.session.settingsManager.setDefaultModelAndProvider(input.model.provider, input.model.id);
  } else {
    input.record.model = input.inputModel;
  }

  if (!input.thinkingLevel) {
    return;
  }

  input.session.setThinkingLevel(input.thinkingLevel);
  input.session.settingsManager.setDefaultThinkingLevel(input.thinkingLevel);
  input.record.thinkingLevel = input.thinkingLevel;
}

function emitModelUpdateAccepted(input: {
  record: SessionRecord;
  accepted: AcceptedSessionCommand;
  now: () => number;
  syncFromRuntime: (record: SessionRecord, options?: { updateTimestamp?: boolean }) => void;
  appendModelPatchEvent: (
    record: SessionRecord,
    accepted: AcceptedSessionCommand,
    ts: number,
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): void {
  input.syncFromRuntime(input.record, { updateTimestamp: false });
  input.record.updatedAt = input.now();
  input.appendModelPatchEvent(input.record, input.accepted, input.record.updatedAt);
  input.emitSessionSummaryUpdated(input.record, input.record.updatedAt);
}

export function handleModelUpdateCommand(input: {
  sessionId: string;
  command: ModelUpdateRequest;
  client: AuthSession;
  connectionId?: string;
  record: SessionRecord;
  session: AgentSessionRuntime["session"];
  parseModelRef: (model: string) => { provider: string; modelId: string } | null;
  parseThinkingLevel: (level: string | undefined) => ThinkingLevel | undefined;
  acceptCommand: (
    record: SessionRecord,
    client: AuthSession,
    connectionId: string | undefined,
    kind: "model",
    payload: ModelUpdateRequest,
    hooks: {
      beforeAccepted?: () => Promise<void>;
      onAccepted: (accepted: AcceptedSessionCommand) => void;
    },
  ) => Promise<CommandAcceptedResponse>;
  now: () => number;
  syncFromRuntime: (record: SessionRecord, options?: { updateTimestamp?: boolean }) => void;
  appendModelPatchEvent: (
    record: SessionRecord,
    accepted: AcceptedSessionCommand,
    ts: number,
  ) => void;
  emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
}): Promise<CommandAcceptedResponse> {
  const model = resolveModelUpdateTarget({
    record: input.record,
    session: input.session,
    modelRef: input.command.model,
    parseModelRef: input.parseModelRef,
  });

  return input.acceptCommand(
    input.record,
    input.client,
    input.connectionId,
    "model",
    input.command,
    buildModelUpdateHooks(input, model),
  );
}

function buildModelUpdateHooks(
  input: {
    command: ModelUpdateRequest;
    record: SessionRecord;
    session: AgentSessionRuntime["session"];
    parseThinkingLevel: (level: string | undefined) => ThinkingLevel | undefined;
    now: () => number;
    syncFromRuntime: (record: SessionRecord, options?: { updateTimestamp?: boolean }) => void;
    appendModelPatchEvent: (
      record: SessionRecord,
      accepted: AcceptedSessionCommand,
      ts: number,
    ) => void;
    emitSessionSummaryUpdated: (record: SessionRecord, ts: number) => void;
  },
  model: Model<Api> | undefined,
): {
  beforeAccepted: () => Promise<void>;
  onAccepted: (accepted: AcceptedSessionCommand) => void;
} {
  return {
    beforeAccepted: async () => {
      const thinkingLevel = input.parseThinkingLevel(input.command.thinkingLevel);
      await applyModelUpdateBeforeAccepted({
        inputModel: input.command.model,
        model,
        thinkingLevel,
        record: input.record,
        session: input.session,
      });
    },
    onAccepted: (accepted) => {
      emitModelUpdateAccepted({
        record: input.record,
        accepted,
        now: input.now,
        syncFromRuntime: input.syncFromRuntime,
        appendModelPatchEvent: input.appendModelPatchEvent,
        emitSessionSummaryUpdated: input.emitSessionSummaryUpdated,
      });
    },
  };
}
