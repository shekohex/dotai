import type { AuthSession } from "../auth.js";
import type {
  ActiveToolsUpdateRequest,
  ClearQueueResponse,
  CommandAcceptedResponse,
  ModelUpdateRequest,
  SettingsUpdateRequest,
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
import type { SessionRecord } from "./types.js";

type RuntimeSession = NonNullable<SessionRecord["runtime"]["session"]>;

export class SessionRegistryStateCommands extends SessionRegistryPromptCommands {
  async updateActiveTools(
    sessionId: string,
    input: ActiveToolsUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = await this.ensureLoaded(sessionId);
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

  async updateModel(
    sessionId: string,
    input: ModelUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = await this.ensureLoaded(sessionId);
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

  async updateSessionName(
    sessionId: string,
    input: SessionNameUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = await this.ensureLoaded(sessionId);
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

  async updateSettings(
    sessionId: string,
    input: SettingsUpdateRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = await this.ensureLoaded(sessionId);
    const session = this.requireRuntimeSession(record);

    return this.acceptCommand(record, client, connectionId, "settings", input, {
      beforeAccepted: async () => {
        applySettingsMutationToRuntimeSession(session, input);
        for (const [targetSessionId, targetRecord] of this.getLoadedSessions().entries()) {
          if (targetSessionId === sessionId) {
            continue;
          }
          const targetSession = this.getRuntimeSession(targetRecord);
          if (!targetSession) {
            continue;
          }
          await refreshRuntimeSessionSettings(targetSession, input);
        }
      },
      onAccepted: (accepted) => {
        const updatedAt = this.now();
        for (const targetRecord of this.getLoadedSessions().values()) {
          this.syncFromRuntime(targetRecord, { updateTimestamp: false });
          targetRecord.updatedAt = updatedAt;
          this.streams.append(sessionEventsStreamId(targetRecord.sessionId), {
            sessionId: targetRecord.sessionId,
            kind: "session_state_patch",
            payload: {
              commandId: accepted.commandId,
              sequence:
                targetRecord.sessionId === record.sessionId
                  ? accepted.sequence
                  : targetRecord.queue.nextSequence,
              patch: {
                settings: { ...targetRecord.settings },
                modelSettings: {
                  defaultProvider: targetRecord.modelSettings.defaultProvider,
                  defaultModel: targetRecord.modelSettings.defaultModel,
                  defaultThinkingLevel: targetRecord.modelSettings.defaultThinkingLevel,
                  enabledModels: targetRecord.modelSettings.enabledModels
                    ? [...targetRecord.modelSettings.enabledModels]
                    : null,
                },
                autoCompactionEnabled: targetRecord.autoCompactionEnabled,
                steeringMode: targetRecord.steeringMode,
                followUpMode: targetRecord.followUpMode,
              },
            },
            ts: updatedAt,
          });
          this.emitSessionSummaryUpdated(targetRecord, updatedAt);
        }
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

  async clearQueue(
    sessionId: string,
    client: AuthSession,
    connectionId?: string,
  ): Promise<ClearQueueResponse> {
    const record = await this.ensureLoaded(sessionId);
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

function applySettingsMutationToRuntimeSession(
  session: RuntimeSession,
  input: SettingsUpdateRequest,
): void {
  switch (input.method) {
    case "setLastChangelogVersion":
      session.settingsManager.setLastChangelogVersion(input.args[0]);
      break;
    case "setDefaultProvider":
      session.settingsManager.setDefaultProvider(input.args[0]);
      break;
    case "setDefaultModel":
      session.settingsManager.setDefaultModel(input.args[0]);
      break;
    case "setDefaultModelAndProvider":
      session.settingsManager.setDefaultModelAndProvider(input.args[0], input.args[1]);
      break;
    case "setDefaultThinkingLevel":
      session.settingsManager.setDefaultThinkingLevel(input.args[0]);
      break;
    case "setEnabledModels":
      session.settingsManager.setEnabledModels(input.args[0] ?? undefined);
      break;
    case "setSteeringMode":
      session.setSteeringMode(input.args[0]);
      break;
    case "setFollowUpMode":
      session.setFollowUpMode(input.args[0]);
      break;
    case "setAutoCompactionEnabled":
      session.setAutoCompactionEnabled(input.args[0]);
      break;
    case "setCompactionEnabled":
      session.settingsManager.setCompactionEnabled(input.args[0]);
      break;
    case "setTheme":
      session.settingsManager.setTheme(input.args[0]);
      break;
    case "setTransport":
      session.settingsManager.setTransport(input.args[0]);
      break;
    case "setRetryEnabled":
      session.settingsManager.setRetryEnabled(input.args[0]);
      break;
    case "setHideThinkingBlock":
      session.settingsManager.setHideThinkingBlock(input.args[0]);
      break;
    case "setShellPath":
      session.settingsManager.setShellPath(input.args[0] ?? undefined);
      break;
    case "setQuietStartup":
      session.settingsManager.setQuietStartup(input.args[0]);
      break;
    case "setShellCommandPrefix":
      session.settingsManager.setShellCommandPrefix(input.args[0] ?? undefined);
      break;
    case "setNpmCommand":
      session.settingsManager.setNpmCommand(input.args[0] ?? undefined);
      break;
    case "setCollapseChangelog":
      session.settingsManager.setCollapseChangelog(input.args[0]);
      break;
    case "setEnableInstallTelemetry":
      session.settingsManager.setEnableInstallTelemetry(input.args[0]);
      break;
    case "setPackages":
      session.settingsManager.setPackages(input.args[0]);
      break;
    case "setProjectPackages":
      session.settingsManager.setProjectPackages(input.args[0]);
      break;
    case "setExtensionPaths":
      session.settingsManager.setExtensionPaths(input.args[0]);
      break;
    case "setProjectExtensionPaths":
      session.settingsManager.setProjectExtensionPaths(input.args[0]);
      break;
    case "setSkillPaths":
      session.settingsManager.setSkillPaths(input.args[0]);
      break;
    case "setProjectSkillPaths":
      session.settingsManager.setProjectSkillPaths(input.args[0]);
      break;
    case "setPromptTemplatePaths":
      session.settingsManager.setPromptTemplatePaths(input.args[0]);
      break;
    case "setProjectPromptTemplatePaths":
      session.settingsManager.setProjectPromptTemplatePaths(input.args[0]);
      break;
    case "setThemePaths":
      session.settingsManager.setThemePaths(input.args[0]);
      break;
    case "setProjectThemePaths":
      session.settingsManager.setProjectThemePaths(input.args[0]);
      break;
    case "setEnableSkillCommands":
      session.settingsManager.setEnableSkillCommands(input.args[0]);
      break;
    case "setShowImages":
      session.settingsManager.setShowImages(input.args[0]);
      break;
    case "setClearOnShrink":
      session.settingsManager.setClearOnShrink(input.args[0]);
      break;
    case "setImageAutoResize":
      session.settingsManager.setImageAutoResize(input.args[0]);
      break;
    case "setBlockImages":
      session.settingsManager.setBlockImages(input.args[0]);
      break;
    case "setDoubleEscapeAction":
      session.settingsManager.setDoubleEscapeAction(input.args[0]);
      break;
    case "setTreeFilterMode":
      session.settingsManager.setTreeFilterMode(input.args[0]);
      break;
    case "setShowHardwareCursor":
      session.settingsManager.setShowHardwareCursor(input.args[0]);
      break;
    case "setEditorPaddingX":
      session.settingsManager.setEditorPaddingX(input.args[0]);
      break;
    case "setAutocompleteMaxVisible":
      session.settingsManager.setAutocompleteMaxVisible(input.args[0]);
      break;
  }
}

async function refreshRuntimeSessionSettings(
  session: RuntimeSession,
  input: SettingsUpdateRequest,
): Promise<void> {
  await session.settingsManager.reload();
  if (input.method === "setSteeringMode") {
    session.setSteeringMode(session.settingsManager.getSteeringMode());
  }
  if (input.method === "setFollowUpMode") {
    session.setFollowUpMode(session.settingsManager.getFollowUpMode());
  }
  if (input.method === "setAutoCompactionEnabled" || input.method === "setCompactionEnabled") {
    session.setAutoCompactionEnabled(session.settingsManager.getCompactionEnabled());
  }
}
