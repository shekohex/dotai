import type { ForwardableRemoteExtensionEvent } from "./local-extension-runner.js";

type ReplaceableEventSlot = {
  replaceableKey: string;
  event: ForwardableRemoteExtensionEvent;
};

type QueuedLocalExtensionEvent =
  | {
      kind: "event";
      event: ForwardableRemoteExtensionEvent;
    }
  | {
      kind: "replaceable";
      slot: ReplaceableEventSlot;
    };

export type LocalExtensionEventQueueState = {
  pendingEvents: QueuedLocalExtensionEvent[];
  replaceableSlots: Map<string, ReplaceableEventSlot>;
  flushPromise: Promise<void> | undefined;
};

export function createLocalExtensionEventQueueState(): LocalExtensionEventQueueState {
  return {
    pendingEvents: [],
    replaceableSlots: new Map(),
    flushPromise: undefined,
  };
}

export function resetLocalExtensionEventQueue(state: LocalExtensionEventQueueState): void {
  state.pendingEvents.length = 0;
  state.replaceableSlots.clear();
  state.flushPromise = undefined;
}

export function enqueueLocalExtensionEvent(input: {
  state: LocalExtensionEventQueueState;
  event: ForwardableRemoteExtensionEvent;
  flush: () => Promise<void>;
}): void {
  const replaceableKey = getReplaceableEventKey(input.event);
  if (replaceableKey === undefined) {
    input.state.pendingEvents.push({ kind: "event", event: input.event });
  } else {
    const existingSlot = input.state.replaceableSlots.get(replaceableKey);
    if (existingSlot) {
      existingSlot.event = input.event;
    } else {
      const slot: ReplaceableEventSlot = {
        replaceableKey,
        event: input.event,
      };
      input.state.replaceableSlots.set(replaceableKey, slot);
      input.state.pendingEvents.push({ kind: "replaceable", slot });
    }
  }

  input.state.flushPromise ??= input.flush().finally(() => {
    input.state.flushPromise = undefined;
  });
}

export function shiftNextLocalExtensionEvent(
  state: LocalExtensionEventQueueState,
): ForwardableRemoteExtensionEvent | undefined {
  const nextEvent = state.pendingEvents.shift();
  if (!nextEvent) {
    return undefined;
  }

  if (nextEvent.kind === "event") {
    return nextEvent.event;
  }

  state.replaceableSlots.delete(nextEvent.slot.replaceableKey);
  return nextEvent.slot.event;
}

function getReplaceableEventKey(event: ForwardableRemoteExtensionEvent): string | undefined {
  if (event.type === "message_update" && event.message.role === "assistant") {
    return "assistant-message-update";
  }

  if (event.type === "tool_execution_update") {
    return `tool-execution-update:${event.toolCallId}`;
  }

  return undefined;
}
