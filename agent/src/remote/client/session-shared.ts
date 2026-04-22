import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { RemoteExtensionMetadata } from "../schemas.js";

export function parseModelRef(value: string): { provider: string; modelId: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator >= value.length - 1) {
    return {
      provider: "unknown",
      modelId: value,
    };
  }

  return {
    provider: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

export function resolveThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return isThinkingLevel(value) ? value : fallback;
}

export function resolveOptionalThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return isThinkingLevel(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function isAgentMessageLike(value: unknown): value is AgentMessage {
  const message = readObject(value);
  if (!message) {
    return false;
  }

  const role = message.role;
  return (
    role === "user" ||
    role === "assistant" ||
    role === "toolResult" ||
    role === "bashExecution" ||
    role === "custom"
  );
}

export function normalizeTranscript(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((message): message is AgentMessage => isAgentMessageLike(message));
}

export function readPendingToolCallId(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const objectValue = readObject(value);
  if (!objectValue) {
    return undefined;
  }

  const toolCallId = objectValue.toolCallId;
  if (typeof toolCallId === "string") {
    return toolCallId;
  }

  const id = objectValue.id;
  return typeof id === "string" ? id : undefined;
}

export function isAgentSessionEventLike(value: unknown): value is AgentSessionEvent {
  return isRecord(value) && typeof value.type === "string";
}

export function isRemoteExtensionMetadataLike(value: unknown): value is RemoteExtensionMetadata {
  if (!isRecord(value)) {
    return false;
  }

  const id = value.id;
  const runtime = value.runtime;
  const extensionPath = value.path;
  return (
    typeof id === "string" &&
    typeof extensionPath === "string" &&
    (runtime === "server" || runtime === "client")
  );
}

export function normalizeRemoteExtensions(value: unknown): RemoteExtensionMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is RemoteExtensionMetadata =>
    isRemoteExtensionMetadataLike(item),
  );
}

export function readErrorMessage(value: unknown): string | undefined {
  const objectValue = readObject(value);
  if (!objectValue) {
    return undefined;
  }

  const error = objectValue.error;
  return typeof error === "string" ? error : undefined;
}

export function normalizeAttachments(images: ImageContent[] | undefined): string[] | undefined {
  if (!images || images.length === 0) {
    return undefined;
  }
  return images.map((image) => `data:${image.mimeType};base64,${image.data}`);
}

export function contentToTextAndImages(content: string | (TextContent | ImageContent)[]): {
  text: string;
  images: ImageContent[];
} {
  if (typeof content === "string") {
    return {
      text: content,
      images: [],
    };
  }

  const text = content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = content.filter((part): part is ImageContent => part.type === "image");
  return {
    text,
    images,
  };
}
