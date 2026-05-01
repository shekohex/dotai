import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { parseRemoteExtensionSyncMetadata } from "./event-bus-bridge.js";
import type { SessionSyncEvent } from "./schemas.js";

export type RemoteExtensionSyncInfo = {
  sync: "ephemeral" | "replaceable" | "durable" | undefined;
  replaceKey: string | undefined;
  stateKey: string;
  deleted: boolean;
};

export function readRemoteExtensionSyncInfo(
  channel: string,
  data: unknown,
): RemoteExtensionSyncInfo {
  const metadata = parseRemoteExtensionSyncMetadata(data);
  const stateKey =
    metadata.replaceKey === undefined ? channel : `${channel}:${metadata.replaceKey}`;
  return {
    sync: metadata.sync,
    replaceKey: metadata.replaceKey,
    stateKey,
    deleted: metadata.deleted,
  };
}

export function readRemoteExtensionEventSyncClass(
  channel: string,
  data: unknown,
): "ephemeral" | "replaceable" | "durable" | undefined {
  return readRemoteExtensionSyncInfo(channel, data).sync;
}

export function readAgentSessionEventReplaceKey(event: AgentSessionEvent): string | undefined {
  if (event.type === "message_update" && event.message.role === "assistant") {
    return "agent_session_event:message_update:assistant";
  }

  if (event.type === "tool_execution_update") {
    return `agent_session_event:tool_execution_update:${event.toolCallId}`;
  }

  return undefined;
}

export function readSessionSyncPatchReplaceKey(
  patch: Extract<SessionSyncEvent, { type: "patch" }>["patch"],
): string | undefined {
  switch (patch.patchType) {
    case "session.state":
      return "session_state_patch";
    case "assistant.message":
      return "agent_session_event:message_update:assistant";
    case "tool.execution": {
      return `agent_session_event:${patch.payload.type}:${patch.payload.toolCallId}`;
    }
    case "queue.update":
      return "agent_session_event:queue_update";
    case "retry.status": {
      return `agent_session_event:${patch.payload.type}`;
    }
    case "compaction.status": {
      return `agent_session_event:${patch.payload.type}`;
    }
    case "extension.custom": {
      const syncInfo = readRemoteExtensionSyncInfo(patch.payload.channel, patch.payload.data);
      return syncInfo.sync === "replaceable"
        ? `extension_custom_event:${syncInfo.stateKey}`
        : undefined;
    }
    case "agent.lifecycle":
    case "bash.chunk":
    case "bash.end":
    case "bash.flush":
    case "bash.start":
    case "command.accepted":
    case "extension.error":
    case "extension.event":
    case "extension.ui.request":
    case "extension.ui.resolved":
      return undefined;
  }

  return undefined;
}
