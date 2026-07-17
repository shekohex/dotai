/**
 * RPC command dispatcher for remote mode. Drives the in-process AgentSession via its direct API —
 * same command surface as `pi --mode rpc` over stdio.
 */

import type {
  AgentSession,
  RpcCommand,
  RpcResponse,
  RpcSessionState,
} from "@earendil-works/pi-coding-agent";

import { errorMessage } from "../utils/error-message.js";

export interface CommandHandlerContext {
  readonly session: AgentSession;
  requestShutdown(): void;
}

export type RemoteCommand = RpcCommand | { id?: string; type: "shutdown" };
type SuccessResponse = {
  id: string | undefined;
  type: "response";
  command: string;
  success: true;
  data?: object | null;
};
export type CommandResponse = RpcResponse | SuccessResponse;
export type WriteFn = (obj: unknown) => void;
export type CommandHandler = (
  command: RemoteCommand,
  write: WriteFn,
) => Promise<CommandResponse | null>;

export function createCommandHandler(ctx: CommandHandlerContext): CommandHandler {
  const { session } = ctx;
  return async (command: RemoteCommand, write: WriteFn): Promise<CommandResponse | null> => {
    const id = command.id;
    switch (command.type) {
      case "prompt":
        return handlePrompt(ctx, id, command, write);
      case "steer":
        await session.steer(command.message, command.images);
        return ok(id, "steer");
      case "follow_up":
        await session.followUp(command.message, command.images);
        return ok(id, "follow_up");
      case "abort":
        await session.abort();
        return ok(id, "abort");
      case "new_session":
        return ok(id, "new_session", { cancelled: true });
      case "get_state":
        return ok(id, "get_state", collectState(session));
      case "set_model":
        return err(id, "set_model", "model changes not supported in remote mode");
      case "cycle_model":
        return ok(id, "cycle_model", null);
      case "get_available_models":
        return ok(id, "get_available_models", {
          models: session.modelRuntime.getAvailableSnapshot(),
        });
      case "set_thinking_level":
        session.setThinkingLevel(command.level);
        return ok(id, "set_thinking_level");
      case "cycle_thinking_level": {
        const level = session.cycleThinkingLevel();
        return level === null
          ? ok(id, "cycle_thinking_level", null)
          : ok(id, "cycle_thinking_level", { level });
      }
      case "set_steering_mode":
        session.setSteeringMode(command.mode);
        return ok(id, "set_steering_mode");
      case "set_follow_up_mode":
        session.setFollowUpMode(command.mode);
        return ok(id, "set_follow_up_mode");
      case "compact":
        return ok(id, "compact", await session.compact(command.customInstructions));
      case "set_auto_compaction":
        session.setAutoCompactionEnabled(command.enabled);
        return ok(id, "set_auto_compaction");
      case "set_auto_retry":
        session.setAutoRetryEnabled(command.enabled);
        return ok(id, "set_auto_retry");
      case "abort_retry":
        session.abortRetry();
        return ok(id, "abort_retry");
      case "bash":
        return ok(
          id,
          "bash",
          await session.executeBash(command.command, undefined, {
            excludeFromContext: command.excludeFromContext,
          }),
        );
      case "abort_bash":
        session.abortBash();
        return ok(id, "abort_bash");
      case "get_session_stats":
        return ok(id, "get_session_stats", session.getSessionStats());
      case "get_last_assistant_text":
        return ok(id, "get_last_assistant_text", { text: session.getLastAssistantText() });
      case "set_session_name": {
        const name = command.name.trim();
        if (!name) return err(id, "set_session_name", "Session name cannot be empty");
        session.setSessionName(name);
        return ok(id, "set_session_name");
      }
      case "get_messages":
        return ok(id, "get_messages", { messages: session.messages });
      case "get_entries": {
        let entries = session.sessionManager.getEntries();
        if (command.since !== undefined) {
          const sinceIndex = entries.findIndex((entry) => entry.id === command.since);
          if (sinceIndex === -1) return err(id, "get_entries", `Entry not found: ${command.since}`);
          entries = entries.slice(sinceIndex + 1);
        }
        return ok(id, "get_entries", { entries, leafId: session.sessionManager.getLeafId() });
      }
      case "get_tree":
        return ok(id, "get_tree", {
          tree: session.sessionManager.getTree(),
          leafId: session.sessionManager.getLeafId(),
        });
      case "get_commands":
        return ok(id, "get_commands", { commands: [] });
      case "clone":
      case "export_html":
      case "fork":
      case "get_fork_messages":
      case "switch_session":
      case "shutdown":
        return handleExtended(ctx, id, command);
    }
    return null;
  };
}

function collectState(session: AgentSession): RpcSessionState {
  return {
    model: session.model,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    autoCompactionEnabled: session.autoCompactionEnabled,
    messageCount: session.messages.length,
    pendingMessageCount: session.pendingMessageCount,
  };
}

function handlePrompt(
  ctx: CommandHandlerContext,
  id: string | undefined,
  command: Extract<RpcCommand, { type: "prompt" }>,
  write: WriteFn,
): RpcResponse | null {
  // Async: emit the authoritative response only after prompt preflight succeeds.
  let preflightOk = false;
  void ctx.session
    .prompt(command.message, {
      images: command.images,
      streamingBehavior: command.streamingBehavior,
      source: "rpc",
      preflightResult: (didSucceed) => {
        if (didSucceed) {
          preflightOk = true;
          write(ok(id, "prompt"));
        }
      },
    })
    .catch((e: unknown) => {
      if (!preflightOk) write(err(id, "prompt", errorMessage(e)));
    });
  return null;
}

function handleExtended(
  ctx: CommandHandlerContext,
  _id: string | undefined,
  command: RemoteCommand,
): CommandResponse {
  // Remote-mode-specific clean process shutdown.
  if (command.type === "shutdown") {
    ctx.requestShutdown();
    return ok(undefined, "shutdown");
  }
  return err(command.id, command.type, "command not supported in remote mode");
}

function ok(id: string | undefined, command: string, data?: object | null): SuccessResponse {
  if (data === undefined) {
    return { id, type: "response", command, success: true };
  }
  return { id, type: "response", command, success: true, data };
}

function err(id: string | undefined, command: string, message: string): RpcResponse {
  return { id, type: "response", command, success: false, error: message };
}
