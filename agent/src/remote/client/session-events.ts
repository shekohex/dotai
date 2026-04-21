import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

export type RemoteAgentSessionState = {
  messages: AgentMessage[];
  pendingToolCalls: Set<string>;
  isStreaming: boolean;
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  streamingMessage?: AgentMessage;
  errorMessage?: string;
};

export type AgentEventDerivedState = {
  queuedSteeringMessages: string[];
  queuedFollowUpMessages: string[];
  queueDepth: number;
  isRetrying: boolean;
  retryAttempt: number;
  isCompacting: boolean;
};

export function applyRemoteAgentSessionEvent(
  state: RemoteAgentSessionState,
  event: AgentSessionEvent,
  current: AgentEventDerivedState,
): AgentEventDerivedState {
  applyAgentStreamingState(state, event);
  applyAgentMessageState(state, event);
  applyAgentToolState(state, event);
  return applyAgentQueueAndRetryState(event, current);
}

function applyAgentStreamingState(state: RemoteAgentSessionState, event: AgentSessionEvent): void {
  if (event.type === "agent_start") {
    state.isStreaming = true;
  }

  if (event.type === "agent_end") {
    state.isStreaming = false;
    state.streamingMessage = undefined;
    state.pendingToolCalls.clear();
  }
}

function applyAgentMessageState(state: RemoteAgentSessionState, event: AgentSessionEvent): void {
  if (event.type === "message_start") {
    if (event.message.role === "assistant") {
      state.streamingMessage = event.message;
    }
    if (event.message.role === "user" || event.message.role === "custom") {
      state.messages = [...state.messages, event.message];
    }
  }

  if (event.type === "message_update" && event.message.role === "assistant") {
    state.streamingMessage = event.message;
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    state.streamingMessage = undefined;
    state.messages = [...state.messages, event.message];
  }
}

function applyAgentToolState(state: RemoteAgentSessionState, event: AgentSessionEvent): void {
  if (event.type === "tool_execution_start") {
    state.pendingToolCalls.add(event.toolCallId);
  }

  if (event.type === "tool_execution_end") {
    state.pendingToolCalls.delete(event.toolCallId);
  }
}

function applyAgentQueueAndRetryState(
  event: AgentSessionEvent,
  current: AgentEventDerivedState,
): AgentEventDerivedState {
  const next = { ...current };

  if (event.type === "queue_update") {
    next.queuedSteeringMessages = [...event.steering];
    next.queuedFollowUpMessages = [...event.followUp];
    next.queueDepth = next.queuedSteeringMessages.length + next.queuedFollowUpMessages.length;
  }

  if (event.type === "auto_retry_start") {
    next.isRetrying = true;
    next.retryAttempt = event.attempt;
  }

  if (event.type === "auto_retry_end") {
    next.isRetrying = false;
    next.retryAttempt = event.attempt;
  }

  if (event.type === "compaction_start") {
    next.isCompacting = true;
  }

  if (event.type === "compaction_end") {
    next.isCompacting = false;
  }

  return next;
}
