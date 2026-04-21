import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { RemoteApiClient } from "../../remote-api-client.js";
import {
  followUpRemoteSession,
  promptRemoteSession,
  sendUserMessageRemoteSession,
  steerRemoteSession,
} from "../session-ops.js";
import {
  abortRemoteSession,
  clearQueueRemoteSession,
  cycleModelRemoteSession,
  setActiveToolsRemoteSession,
  setModelRemoteSession,
  setSessionNameRemoteSession,
  setThinkingLevelRemoteSession,
  waitForIdleRemoteSession,
} from "../session-state-ops.js";

export async function promptRemoteSessionMethod(input: {
  waitForPendingMutations: () => Promise<void>;
  isStreaming: boolean;
  steer: (text: string, images?: ImageContent[]) => Promise<void>;
  followUp: (text: string, images?: ImageContent[]) => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
  text: string;
  options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" };
}): Promise<void> {
  await promptRemoteSession({
    waitForPendingMutations: input.waitForPendingMutations,
    isStreaming: input.isStreaming,
    steer: input.steer,
    followUp: input.followUp,
    client: input.client,
    sessionId: input.sessionId,
    text: input.text,
    options: input.options,
  });
}

export async function steerRemoteSessionMethod(input: {
  waitForPendingMutations: () => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
  text: string;
  images?: ImageContent[];
}): Promise<void> {
  await steerRemoteSession({
    waitForPendingMutations: input.waitForPendingMutations,
    client: input.client,
    sessionId: input.sessionId,
    text: input.text,
    images: input.images,
  });
}

export async function followUpRemoteSessionMethod(input: {
  waitForPendingMutations: () => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
  text: string;
  images?: ImageContent[];
}): Promise<void> {
  await followUpRemoteSession({
    waitForPendingMutations: input.waitForPendingMutations,
    client: input.client,
    sessionId: input.sessionId,
    text: input.text,
    images: input.images,
  });
}

export async function sendUserMessageRemoteSessionMethod(input: {
  waitForPendingMutations: () => Promise<void>;
  isStreaming: boolean;
  content: string | (TextContent | ImageContent)[];
  options?: { deliverAs?: "steer" | "followUp" };
  steer: (text: string, images?: ImageContent[]) => Promise<void>;
  followUp: (text: string, images?: ImageContent[]) => Promise<void>;
  prompt: (
    text: string,
    options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
  ) => Promise<void>;
}): Promise<void> {
  await sendUserMessageRemoteSession({
    waitForPendingMutations: input.waitForPendingMutations,
    isStreaming: input.isStreaming,
    content: input.content,
    options: input.options,
    steer: input.steer,
    followUp: input.followUp,
    prompt: input.prompt,
  });
}

export function clearQueueRemoteSessionMethod(input: {
  queuedSteeringMessages: string[];
  queuedFollowUpMessages: string[];
  queueDepth: number;
  setQueueState: (state: { steering: string[]; followUp: string[]; queueDepth: number }) => void;
  enqueueMutation: (execute: () => Promise<void>, rollback: () => void, label: string) => void;
  client: RemoteApiClient;
  sessionId: string;
}): { steering: string[]; followUp: string[] } {
  return clearQueueRemoteSession({
    queuedSteeringMessages: input.queuedSteeringMessages,
    queuedFollowUpMessages: input.queuedFollowUpMessages,
    queueDepth: input.queueDepth,
    setQueueState: input.setQueueState,
    enqueueMutation: input.enqueueMutation,
    client: input.client,
    sessionId: input.sessionId,
  });
}

export async function waitForIdleRemoteSessionMethod(input: {
  isStreaming: boolean;
  queueDepth: number;
  idleResolvers: Set<() => void>;
}): Promise<void> {
  await waitForIdleRemoteSession({
    isStreaming: input.isStreaming,
    queueDepth: input.queueDepth,
    idleResolvers: input.idleResolvers,
  });
}

export async function abortRemoteSessionMethod(input: {
  waitForPendingMutations: () => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
}): Promise<void> {
  await abortRemoteSession({
    waitForPendingMutations: input.waitForPendingMutations,
    client: input.client,
    sessionId: input.sessionId,
  });
}

export async function setModelRemoteSessionMethod(input: {
  client: RemoteApiClient;
  sessionId: string;
  model: Model<Api>;
  setModelState: (model: Model<Api>) => void;
  setDefaultModel: (provider: string, modelId: string) => void;
}): Promise<void> {
  await setModelRemoteSession({
    client: input.client,
    sessionId: input.sessionId,
    model: input.model,
    setModelState: input.setModelState,
    setDefaultModel: input.setDefaultModel,
  });
}

export function cycleModelRemoteSessionMethod(input: {
  modelRegistry: ModelRegistry;
  model: Model<Api> | undefined;
  direction: "forward" | "backward";
  setModel: (model: Model<Api>) => Promise<void>;
  thinkingLevel: ThinkingLevel;
}): Promise<{ model: Model<Api>; thinkingLevel: ThinkingLevel; isScoped: boolean } | undefined> {
  return cycleModelRemoteSession({
    modelRegistry: input.modelRegistry,
    model: input.model,
    direction: input.direction,
    setModel: input.setModel,
    thinkingLevel: input.thinkingLevel,
  });
}

export function setThinkingLevelRemoteSessionMethod(input: {
  level: ThinkingLevel;
  previousThinkingLevel: ThinkingLevel;
  modelRef: string;
  setThinkingLevelState: (thinkingLevel: ThinkingLevel) => void;
  enqueueMutation: (execute: () => Promise<void>, rollback: () => void, label: string) => void;
  client: RemoteApiClient;
  sessionId: string;
  setDefaultThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
}): void {
  setThinkingLevelRemoteSession({
    level: input.level,
    previousThinkingLevel: input.previousThinkingLevel,
    modelRef: input.modelRef,
    setThinkingLevelState: input.setThinkingLevelState,
    enqueueMutation: input.enqueueMutation,
    client: input.client,
    sessionId: input.sessionId,
    setDefaultThinkingLevel: input.setDefaultThinkingLevel,
  });
}

export function setSessionNameRemoteSessionMethod(input: {
  name: string;
  previousName: string | undefined;
  setSessionNameState: (name: string) => void;
  enqueueMutation: (execute: () => Promise<void>, rollback: () => void, label: string) => void;
  client: RemoteApiClient;
  sessionId: string;
}): void {
  setSessionNameRemoteSession({
    name: input.name,
    previousName: input.previousName,
    setSessionNameState: input.setSessionNameState,
    enqueueMutation: input.enqueueMutation,
    client: input.client,
    sessionId: input.sessionId,
  });
}

export function setActiveToolsRemoteSessionMethod(input: {
  toolNames: string[];
  previousToolNames: string[];
  setActiveToolsState: (toolNames: string[]) => void;
  enqueueMutation: (execute: () => Promise<void>, rollback: () => void, label: string) => void;
  client: RemoteApiClient;
  sessionId: string;
}): void {
  setActiveToolsRemoteSession({
    toolNames: input.toolNames,
    previousToolNames: input.previousToolNames,
    setActiveToolsState: input.setActiveToolsState,
    enqueueMutation: input.enqueueMutation,
    client: input.client,
    sessionId: input.sessionId,
  });
}
