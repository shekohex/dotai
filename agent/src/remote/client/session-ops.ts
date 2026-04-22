import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { RemoteApiClient } from "../remote-api-client.js";
import type { SessionSnapshot } from "../schemas.js";
import {
  contentToTextAndImages,
  normalizeAttachments,
  resolveThinkingLevel,
} from "./session-shared.js";

export async function promptRemoteSession(input: {
  waitForPendingMutations: () => Promise<void>;
  isStreaming: boolean;
  steer: (text: string, images?: ImageContent[]) => Promise<void>;
  followUp: (text: string, images?: ImageContent[]) => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
  text: string;
  options?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" };
}): Promise<void> {
  await input.waitForPendingMutations();
  if (input.isStreaming) {
    if (!input.options?.streamingBehavior) {
      throw new Error("Prompt requires streamingBehavior while remote session is streaming");
    }
    if (input.options.streamingBehavior === "steer") {
      await input.steer(input.text, input.options.images);
    } else {
      await input.followUp(input.text, input.options.images);
    }
    return;
  }

  await input.client.prompt(input.sessionId, {
    text: input.text,
    attachments: normalizeAttachments(input.options?.images),
  });
}

export async function steerRemoteSession(input: {
  waitForPendingMutations: () => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
  text: string;
  images?: ImageContent[];
}): Promise<void> {
  await input.waitForPendingMutations();
  await input.client.steer(input.sessionId, {
    text: input.text,
    attachments: normalizeAttachments(input.images),
  });
}

export async function followUpRemoteSession(input: {
  waitForPendingMutations: () => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
  text: string;
  images?: ImageContent[];
}): Promise<void> {
  await input.waitForPendingMutations();
  await input.client.followUp(input.sessionId, {
    text: input.text,
    attachments: normalizeAttachments(input.images),
  });
}

export async function sendUserMessageRemoteSession(input: {
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
  await input.waitForPendingMutations();
  const { text, images } = contentToTextAndImages(input.content);
  if (input.isStreaming) {
    if (input.options?.deliverAs === "steer") {
      await input.steer(text, images);
    } else {
      await input.followUp(text, images);
    }
    return;
  }

  await input.prompt(text, { images });
}

export function getLastAssistantTextRemoteSession(messages: AgentMessage[]): string | undefined {
  const assistant = [...messages].toReversed().find((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") {
    return undefined;
  }
  const text = assistant.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  return text || undefined;
}

export function getAllToolsRemoteSession(activeTools: string[]): Array<{
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo: unknown;
}> {
  return activeTools.map((toolName) => ({
    name: toolName,
    description: `${toolName} tool`,
    parameters: {},
    sourceInfo: {
      source: "remote",
    },
  }));
}

export function getAvailableThinkingLevelsRemoteSession(
  model: Model<Api> | undefined,
): ThinkingLevel[] {
  if (model?.reasoning !== true) {
    return ["off"];
  }
  return ["off", "minimal", "low", "medium", "high", "xhigh"];
}

export async function reloadRemoteSession(input: {
  waitForPendingMutations: () => Promise<void>;
  client: RemoteApiClient;
  sessionId: string;
  applyAuthoritativeCwd: (nextCwd: string) => void;
  applyRemoteCatalogSnapshot: (snapshot: SessionSnapshot) => void;
  applyRemoteSettingsSnapshot: (snapshot: SessionSnapshot) => void;
  applyRemoteExtensionsSnapshot: (snapshot: SessionSnapshot) => void;
  resolveModel: (modelRefValue: string) => Model<Api>;
  activeToolsTarget: { value: string[] };
  queueDepthTarget: { value: number };
  thinkingLevelTarget: { value: ThinkingLevel };
  state: { thinkingLevel: ThinkingLevel; model: Model<Api> | undefined };
  sessionManager: SessionManager;
}): Promise<void> {
  await input.waitForPendingMutations();
  const snapshot = await input.client.getSessionSnapshot(input.sessionId);
  input.applyAuthoritativeCwd(snapshot.cwd);
  input.applyRemoteCatalogSnapshot(snapshot);
  input.applyRemoteSettingsSnapshot(snapshot);
  input.applyRemoteExtensionsSnapshot(snapshot);
  input.thinkingLevelTarget.value = resolveThinkingLevel(
    snapshot.thinkingLevel,
    input.thinkingLevelTarget.value,
  );
  input.state.thinkingLevel = input.thinkingLevelTarget.value;
  input.state.model = input.resolveModel(snapshot.model);
  input.activeToolsTarget.value = [...snapshot.activeTools];
  input.queueDepthTarget.value = snapshot.queue.depth;
  input.sessionManager.appendSessionInfo(snapshot.sessionName);
}
