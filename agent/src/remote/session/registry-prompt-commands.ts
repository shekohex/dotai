import type { AuthSession } from "../auth.js";
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
import { SessionRegistryManagement } from "./registry-management.js";

export class SessionRegistryPromptCommands extends SessionRegistryManagement {
  prompt(
    sessionId: string,
    input: PromptCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
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
    });
  }

  steer(
    sessionId: string,
    input: SteerCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
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

  followUp(
    sessionId: string,
    input: FollowUpCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
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

  interrupt(
    sessionId: string,
    input: InterruptCommandRequest,
    client: AuthSession,
    connectionId?: string,
  ): Promise<CommandAcceptedResponse> {
    const record = this.getRequired(sessionId);
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
