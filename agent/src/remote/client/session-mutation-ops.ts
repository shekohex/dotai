import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import {
  applyRemoteAgentSessionEvent,
  type AgentEventDerivedState,
  type RemoteAgentSessionState,
} from "./session-events.js";

export function enqueueRemoteSessionMutation(input: {
  currentMutationQueue: Promise<void>;
  execute: () => Promise<void>;
  rollback: () => void;
  label: string;
  handleRemoteError: (message: string) => void;
  setMutationQueue: (next: Promise<void>) => void;
}): void {
  const nextQueue = input.currentMutationQueue.then(input.execute).catch((error) => {
    input.rollback();
    const message = error instanceof Error ? error.message : String(error);
    input.handleRemoteError(`${input.label}: ${message}`);
  });
  input.setMutationQueue(nextQueue);
}

export function handleRemoteSessionErrorMessage(input: {
  message: string;
  uiContext: ExtensionUIContext | undefined;
  isAgentMessageLike: (value: unknown) => value is AgentMessage;
  applyAgentSessionEvent: (event: {
    type: "message_start" | "message_end";
    message: AgentMessage;
  }) => void;
}): void {
  input.uiContext?.notify(input.message, "error");

  const messageCandidate: unknown = {
    role: "custom",
    customType: "remote_error",
    content: input.message,
    display: true,
    details: {
      source: "remote",
    },
  };

  if (input.isAgentMessageLike(messageCandidate)) {
    input.applyAgentSessionEvent({ type: "message_start", message: messageCandidate });
    input.applyAgentSessionEvent({ type: "message_end", message: messageCandidate });
  }
}

export function emitRemoteSessionAgentEvent(input: {
  event: AgentSessionEvent;
  listeners: Set<AgentSessionEventListener>;
  currentEmitQueue: Promise<void>;
  setEmitQueue: (next: Promise<void>) => void;
  isStreaming: boolean;
  queueDepth: number;
  idleResolvers: Set<() => void>;
}): void {
  const nextQueue = input.currentEmitQueue
    .then(() => {
      for (const listener of input.listeners) {
        listener(input.event);
      }
    })
    .catch(() => {})
    .then(() => {
      if (!input.isStreaming && input.queueDepth === 0 && input.idleResolvers.size > 0) {
        const resolvers = [...input.idleResolvers.values()];
        input.idleResolvers.clear();
        for (const resolve of resolvers) {
          resolve();
        }
      }
    });
  input.setEmitQueue(nextQueue);
}

export function applyRemoteAgentEventAndEmit(input: {
  event: AgentSessionEvent;
  state: RemoteAgentSessionState;
  currentDerivedState: AgentEventDerivedState;
  listeners: Set<AgentSessionEventListener>;
  currentEmitQueue: Promise<void>;
  setEmitQueue: (next: Promise<void>) => void;
  isStreaming: boolean;
  queueDepth: number;
  idleResolvers: Set<() => void>;
}): AgentEventDerivedState {
  const nextDerivedState = applyRemoteAgentSessionEvent(
    input.state,
    input.event,
    input.currentDerivedState,
  );
  emitRemoteSessionAgentEvent({
    event: input.event,
    listeners: input.listeners,
    currentEmitQueue: input.currentEmitQueue,
    setEmitQueue: input.setEmitQueue,
    isStreaming: input.isStreaming,
    queueDepth: input.queueDepth,
    idleResolvers: input.idleResolvers,
  });
  return nextDerivedState;
}

export function handleRemoteSessionErrorBridge(input: {
  message: string;
  setErrorMessage: (message: string) => void;
  uiContext: ExtensionUIContext | undefined;
  isAgentMessageLike: (value: unknown) => value is AgentMessage;
  applyAgentSessionEvent: (event: {
    type: "message_start" | "message_end";
    message: AgentMessage;
  }) => void;
}): void {
  input.setErrorMessage(input.message);
  handleRemoteSessionErrorMessage({
    message: input.message,
    uiContext: input.uiContext,
    isAgentMessageLike: input.isAgentMessageLike,
    applyAgentSessionEvent: input.applyAgentSessionEvent,
  });
}
