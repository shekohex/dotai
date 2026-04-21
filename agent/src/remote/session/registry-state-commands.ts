import type { AuthSession } from "../auth.js";
import type {
  ActiveToolsUpdateRequest,
  ClearQueueResponse,
  CommandAcceptedResponse,
  ModelUpdateRequest,
  SessionNameUpdateRequest,
  UiResponseRequest,
  UiResponseResponse,
} from "../schemas.js";
import { sessionEventsStreamId } from "../streams.js";
import {
  handleModelUpdateCommand,
  handleSessionNameUpdateCommand,
  submitUiResponseCommand,
} from "./deps.js";
import { SessionRegistryPromptCommands } from "./registry-prompt-commands.js";

export class SessionRegistryStateCommands extends SessionRegistryPromptCommands {
  updateActiveTools(
    sessionId: string,
    input: ActiveToolsUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    const session = this.requireRuntimeSession(record);
    const normalizedToolNames = [...new Set(input.toolNames)];

    return this.acceptCommand(record, client, connectionId, "active-tools", input, {
      beforeAccepted: () => {
        session.setActiveToolsByName(normalizedToolNames);
      },
      onAccepted: (accepted) => {
        const updatedAt = this.now();
        this.syncFromRuntime(record, { updateTimestamp: false });
        record.updatedAt = updatedAt;
        this.streams.append(sessionEventsStreamId(record.sessionId), {
          sessionId: record.sessionId,
          kind: "session_state_patch",
          payload: {
            commandId: accepted.commandId,
            sequence: accepted.sequence,
            patch: {
              activeTools: [...record.activeTools],
            },
          },
          ts: updatedAt,
        });
        this.emitSessionSummaryUpdated(record, updatedAt);
      },
    });
  }

  updateModel(
    sessionId: string,
    input: ModelUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    const session = this.requireRuntimeSession(record);
    return handleModelUpdateCommand({
      sessionId,
      command: input,
      client,
      connectionId,
      record,
      session,
      parseModelRef: (modelRef) => this.parseModelRef(modelRef),
      parseThinkingLevel: (level) => this.parseThinkingLevel(level),
      acceptCommand: (targetRecord, targetClient, targetConnectionId, kind, payload, hooks) =>
        this.acceptCommand(targetRecord, targetClient, targetConnectionId, kind, payload, hooks),
      now: this.now,
      syncFromRuntime: (targetRecord, options) => {
        this.syncFromRuntime(targetRecord, options);
      },
      appendModelPatchEvent: (targetRecord, acceptedCommand, ts) => {
        this.streams.append(sessionEventsStreamId(targetRecord.sessionId), {
          sessionId: targetRecord.sessionId,
          kind: "session_state_patch",
          payload: {
            commandId: acceptedCommand.commandId,
            sequence: acceptedCommand.sequence,
            patch: {
              model: targetRecord.model,
              thinkingLevel: targetRecord.thinkingLevel,
              cwd: targetRecord.cwd,
              extensions: targetRecord.extensions,
              availableModels: targetRecord.availableModels,
              modelSettings: targetRecord.modelSettings,
            },
          },
          ts,
        });
      },
      emitSessionSummaryUpdated: (targetRecord, ts) => {
        this.emitSessionSummaryUpdated(targetRecord, ts);
      },
    });
  }

  updateSessionName(
    sessionId: string,
    input: SessionNameUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
    const session = this.getRuntimeSession(record);
    return handleSessionNameUpdateCommand({
      command: input,
      client,
      connectionId,
      record,
      now: this.now,
      session,
      acceptCommand: (targetRecord, targetClient, targetConnectionId, kind, payload, hooks) =>
        this.acceptCommand(targetRecord, targetClient, targetConnectionId, kind, payload, hooks),
      appendSessionNamePatchedEvent: (targetRecord, command, updatedAt) => {
        this.streams.append(sessionEventsStreamId(targetRecord.sessionId), {
          sessionId: targetRecord.sessionId,
          kind: "session_state_patch",
          payload: {
            commandId: command.commandId,
            sequence: command.sequence,
            patch: {
              sessionName: targetRecord.sessionName,
              cwd: targetRecord.cwd,
              extensions: targetRecord.extensions,
            },
          },
          ts: updatedAt,
        });
      },
      emitSessionSummaryUpdated: (targetRecord, ts) => {
        this.emitSessionSummaryUpdated(targetRecord, ts);
      },
    });
  }

  submitUiResponse(
    sessionId: string,
    input: UiResponseRequest,
    client: AuthSession,
    connectionId?: string,
  ): UiResponseResponse {
    const record = this.getRequired(sessionId);
    const resolvedConnectionId = connectionId ?? client.token;
    this.touchPresence(sessionId, client, resolvedConnectionId);
    return submitUiResponseCommand({
      record,
      request: input,
      client,
      connectionId: resolvedConnectionId,
      now: this.now,
      appendUiResolvedEvent: (payload) => {
        this.streams.append(sessionEventsStreamId(record.sessionId), {
          sessionId: record.sessionId,
          kind: "extension_ui_resolved",
          payload,
          ts: this.now(),
        });
      },
    });
  }

  clearQueue(sessionId: string, client: AuthSession, connectionId?: string): ClearQueueResponse {
    const record = this.getRequired(sessionId);
    this.touchPresence(sessionId, client, connectionId);
    const session = this.requireRuntimeSession(record);
    const cleared = session.clearQueue();
    this.syncFromRuntime(record, { updateTimestamp: false });
    return {
      steering: [...cleared.steering],
      followUp: [...cleared.followUp],
    };
  }
}
