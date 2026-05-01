import type { AuthSession } from "../auth.js";
import { appendAndPublish, sessionEventsStreamId } from "../streams.js";
import type {
  CommandAcceptedResponse,
  FollowUpCommandRequest,
  InterruptCommandRequest,
  PromptCommandRequest,
  SteerCommandRequest,
} from "../schemas.js";
import {
  handleFollowUpCommand,
  handleInterruptCommand,
  handlePromptCommand,
  handleSteerCommand,
} from "./deps.js";
import { sanitizeRemoteModel } from "../schema-normalization.js";
import { SessionRegistryManagement } from "./registry-management.js";

export class SessionRegistryPromptCommands extends SessionRegistryManagement {
  async prompt(
    sessionId: string,
    input: PromptCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = await this.ensureLoaded(sessionId);
    const session = this.requireRuntimeSession(record);
    return handlePromptCommand({
      sessionId,
      command: input,
      client,
      connectionId,
      record,
      session,
      acceptCommand: (targetRecord, targetClient, targetConnectionId, kind, payload, hooks) =>
        this.acceptCommand(targetRecord, targetClient, targetConnectionId, kind, payload, hooks),
      isRegisteredExtensionCommand: (targetSession, text) =>
        this.isRegisteredExtensionCommand(targetSession, text),
      ensurePromptPreflight: (targetSession) => this.ensurePromptPreflight(targetSession),
      dispatchRuntimeCommand: (targetRecord, command, operation) => {
        this.dispatchRuntimeCommand(targetRecord, command, operation);
      },
      beforePromptDispatch: (targetRecord) => ({
        previousHasPendingBashMessages: targetRecord.hasPendingBashMessages,
        previousTranscriptLength: targetRecord.transcript.length,
      }),
      afterPromptDispatch: (targetRecord, targetSession, accepted, state) => {
        if (this.isRegisteredExtensionCommand(targetSession, input.text)) {
          const updatedAt = this.now();
          this.syncFromRuntime(targetRecord, { updateTimestamp: false, syncResources: true });
          targetRecord.updatedAt = updatedAt;
          appendAndPublish(
            this.streams,
            this.liveEvents,
            sessionEventsStreamId(targetRecord.sessionId),
            {
              sessionId: targetRecord.sessionId,
              kind: "session_state_patch",
              sessionVersion: String(targetRecord.lastDurableSessionVersion),
              payload: {
                commandId: accepted.commandId,
                sequence: accepted.sequence,
                patch: {
                  model: targetRecord.model,
                  thinkingLevel: targetRecord.thinkingLevel,
                  activeTools: [...targetRecord.activeTools],
                  cwd: targetRecord.cwd,
                  extensions: targetRecord.extensions,
                  resources: {
                    skills: targetRecord.resources.skills.map((skill) => ({ ...skill })),
                    prompts: targetRecord.resources.prompts.map((prompt) => ({ ...prompt })),
                    themes: targetRecord.resources.themes.map((theme) => ({ ...theme })),
                    ...(targetRecord.resources.modes === undefined
                      ? {}
                      : { modes: structuredClone(targetRecord.resources.modes) }),
                    systemPrompt: targetRecord.resources.systemPrompt,
                    appendSystemPrompt: [...targetRecord.resources.appendSystemPrompt],
                  },
                  availableModels: targetRecord.availableModels.map((model) =>
                    sanitizeRemoteModel({ ...model }),
                  ),
                  modelSettings: {
                    defaultProvider: targetRecord.modelSettings.defaultProvider,
                    defaultModel: targetRecord.modelSettings.defaultModel,
                    defaultThinkingLevel: targetRecord.modelSettings.defaultThinkingLevel,
                    enabledModels: targetRecord.modelSettings.enabledModels
                      ? [...targetRecord.modelSettings.enabledModels]
                      : null,
                  },
                  sessionStats: {
                    ...targetRecord.sessionStats,
                    tokens: {
                      input: targetRecord.sessionStats.tokens.input,
                      output: targetRecord.sessionStats.tokens.output,
                      cacheRead: targetRecord.sessionStats.tokens.cacheRead,
                      cacheWrite: targetRecord.sessionStats.tokens.cacheWrite,
                      total: targetRecord.sessionStats.tokens.total,
                    },
                    ...(targetRecord.sessionStats.contextUsage
                      ? { contextUsage: { ...targetRecord.sessionStats.contextUsage } }
                      : {}),
                  },
                  ...(targetRecord.contextUsage
                    ? { contextUsage: { ...targetRecord.contextUsage } }
                    : {}),
                  usageCost: targetRecord.usageCost,
                },
              },
              ts: updatedAt,
            },
          );
          this.emitSessionSummaryUpdated(targetRecord, updatedAt);
        }

        if (!state.previousHasPendingBashMessages) {
          return;
        }
        const messages = targetSession.messages
          .slice(state.previousTranscriptLength)
          .filter(
            (
              message,
            ): message is Extract<
              (typeof targetSession.messages)[number],
              { role: "bashExecution" }
            > => message.role === "bashExecution",
          );
        if (messages.length === 0) {
          return;
        }
        appendAndPublish(
          this.streams,
          this.liveEvents,
          sessionEventsStreamId(targetRecord.sessionId),
          {
            sessionId: targetRecord.sessionId,
            kind: "bash_flush",
            sessionVersion: String(targetRecord.lastDurableSessionVersion),
            payload: {
              messages,
            },
            ts: this.now(),
          },
        );
      },
    });
  }

  async steer(
    sessionId: string,
    input: SteerCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = await this.ensureLoaded(sessionId);
    this.requireRuntimeSession(record);
    return handleSteerCommand({
      command: input,
      client,
      connectionId,
      record,
      acceptCommand: (targetRecord, targetClient, targetConnectionId, kind, payload, onAccepted) =>
        this.acceptCommand(
          targetRecord,
          targetClient,
          targetConnectionId,
          kind,
          payload,
          onAccepted,
        ),
      requireRuntimeSession: (targetRecord) => this.requireRuntimeSession(targetRecord),
      dispatchRuntimeCommand: (targetRecord, command, operation) => {
        this.dispatchRuntimeCommand(targetRecord, command, operation);
      },
    });
  }

  async followUp(
    sessionId: string,
    input: FollowUpCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = await this.ensureLoaded(sessionId);
    this.requireRuntimeSession(record);
    return handleFollowUpCommand({
      command: input,
      client,
      connectionId,
      record,
      acceptCommand: (targetRecord, targetClient, targetConnectionId, kind, payload, onAccepted) =>
        this.acceptCommand(
          targetRecord,
          targetClient,
          targetConnectionId,
          kind,
          payload,
          onAccepted,
        ),
      requireRuntimeSession: (targetRecord) => this.requireRuntimeSession(targetRecord),
      dispatchRuntimeCommand: (targetRecord, command, operation) => {
        this.dispatchRuntimeCommand(targetRecord, command, operation);
      },
    });
  }

  async interrupt(
    sessionId: string,
    input: InterruptCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = await this.ensureLoaded(sessionId);
    this.requireRuntimeSession(record);
    return handleInterruptCommand({
      command: input,
      client,
      connectionId,
      record,
      acceptCommand: (targetRecord, targetClient, targetConnectionId, kind, payload, onAccepted) =>
        this.acceptCommand(
          targetRecord,
          targetClient,
          targetConnectionId,
          kind,
          payload,
          onAccepted,
        ),
      requireRuntimeSession: (targetRecord) => this.requireRuntimeSession(targetRecord),
      dispatchRuntimeCommand: (targetRecord, command, operation) => {
        this.dispatchRuntimeCommand(targetRecord, command, operation);
      },
    });
  }
}
