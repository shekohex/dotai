import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { RemoteApiClient } from "../remote-api-client.js";

export function clearQueueRemoteSession(input: {
  queuedSteeringMessages: string[];
  queuedFollowUpMessages: string[];
  queueDepth: number;
  setQueueState: (state: { steering: string[]; followUp: string[]; queueDepth: number }) => void;
  enqueueMutation: (execute: () => Promise<void>, rollback: () => void, label: string) => void;
  client: RemoteApiClient;
  sessionId: string;
}): { steering: string[]; followUp: string[] } {
  const steering = [...input.queuedSteeringMessages];
  const followUp = [...input.queuedFollowUpMessages];
  const previousQueueDepth = input.queueDepth;
  input.setQueueState({ steering: [], followUp: [], queueDepth: 0 });
  input.enqueueMutation(
    async () => {
      await input.client.clearQueue(input.sessionId);
    },
    () => {
      input.setQueueState({ steering, followUp, queueDepth: previousQueueDepth });
    },
    "Failed to clear queued messages",
  );
  return { steering, followUp };
}

export async function waitForIdleRemoteSession(input: {
  isStreaming: boolean;
  queueDepth: number;
  idleResolvers: Set<() => void>;
}): Promise<void> {
  if (!input.isStreaming && input.queueDepth === 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    input.idleResolvers.add(resolve);
  });
}

export async function abortRemoteSession(input: {
  waitForPendingMutations: () => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
}): Promise<void> {
  await input.waitForPendingMutations();
  await input.client.interrupt(input.sessionId);
}

export async function setModelRemoteSession(input: {
  client: RemoteApiClient;
  sessionId: string;
  model: Model<Api>;
  setModelState: (model: Model<Api>) => void;
  setDefaultModel: (provider: string, modelId: string) => void;
}): Promise<void> {
  await input.client.updateModel(input.sessionId, {
    model: `${input.model.provider}/${input.model.id}`,
  });
  input.setModelState(input.model);
  input.setDefaultModel(input.model.provider, input.model.id);
}

export async function cycleModelRemoteSession(input: {
  modelRegistry: { refresh: () => void; getAvailable: () => Model<Api>[] };
  model: Model<Api> | undefined;
  direction: "forward" | "backward";
  setModel: (model: Model<Api>) => Promise<void>;
  thinkingLevel: ThinkingLevel;
}): Promise<{ model: Model<Api>; thinkingLevel: ThinkingLevel; isScoped: boolean } | undefined> {
  input.modelRegistry.refresh();
  const available = input.modelRegistry.getAvailable();
  if (available.length <= 1 || !input.model) {
    return undefined;
  }

  const currentIndex = available.findIndex(
    (candidate) => candidate.provider === input.model?.provider && candidate.id === input.model?.id,
  );
  const resolvedCurrentIndex = Math.max(currentIndex, 0);
  const delta = input.direction === "forward" ? 1 : -1;
  const nextIndex = (resolvedCurrentIndex + delta + available.length) % available.length;
  const nextModel = available[nextIndex];
  if (nextModel === undefined) {
    return undefined;
  }

  await input.setModel(nextModel);
  return {
    model: nextModel,
    thinkingLevel: input.thinkingLevel,
    isScoped: false,
  };
}

export function setThinkingLevelRemoteSession(input: {
  level: ThinkingLevel;
  previousThinkingLevel: ThinkingLevel;
  modelRef: string;
  setThinkingLevelState: (level: ThinkingLevel) => void;
  enqueueMutation: (execute: () => Promise<void>, rollback: () => void, label: string) => void;
  client: RemoteApiClient;
  sessionId: string;
  setDefaultThinkingLevel: (level: ThinkingLevel) => void;
}): void {
  input.setThinkingLevelState(input.level);
  input.enqueueMutation(
    async () => {
      await input.client.updateModel(input.sessionId, {
        model: input.modelRef,
        thinkingLevel: input.level,
      });
      input.setDefaultThinkingLevel(input.level);
    },
    () => {
      input.setThinkingLevelState(input.previousThinkingLevel);
    },
    "Failed to update thinking level",
  );
}

export function setSessionNameRemoteSession(input: {
  name: string;
  previousName: string | undefined;
  setSessionNameState: (name: string) => void;
  enqueueMutation: (execute: () => Promise<void>, rollback: () => void, label: string) => void;
  client: RemoteApiClient;
  sessionId: string;
}): void {
  input.setSessionNameState(input.name);
  input.enqueueMutation(
    async () => {
      await input.client.updateSessionName(input.sessionId, input.name);
    },
    () => {
      input.setSessionNameState(input.previousName ?? "");
    },
    "Failed to update session name",
  );
}

export function setActiveToolsRemoteSession(input: {
  toolNames: string[];
  previousToolNames: string[];
  setActiveToolsState: (toolNames: string[]) => void;
  enqueueMutation: (execute: () => Promise<void>, rollback: () => void, label: string) => void;
  client: RemoteApiClient;
  sessionId: string;
}): void {
  input.setActiveToolsState(input.toolNames);
  input.enqueueMutation(
    async () => {
      await input.client.updateActiveTools(input.sessionId, {
        toolNames: input.toolNames,
      });
    },
    () => {
      input.setActiveToolsState(input.previousToolNames);
    },
    "Failed to update active tools",
  );
}
