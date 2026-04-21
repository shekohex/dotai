import type { AssistantMessage } from "@mariozechner/pi-ai";
import { AssistantMessageComponent } from "@mariozechner/pi-coding-agent";
import { theme as interactiveTheme } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  Markdown,
  Spacer,
  Text,
  type Component,
  type Container,
  type MarkdownTheme,
} from "@mariozechner/pi-tui";
import {
  buildInlineRenderableSegments,
  hasRenderableMermaid,
  type MermaidDetails,
} from "./renderable.js";

type AssistantMessagePatchInstance = {
  contentContainer: Container;
  hideThinkingBlock: boolean;
  markdownTheme: MarkdownTheme;
  hiddenThinkingLabel: string;
  lastMessage?: AssistantMessage;
};

let assistantPatchInstalled = false;

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function appendAssistantTextContent(
  container: Container,
  text: string,
  markdownTheme: MarkdownTheme,
  renderInlineMermaid: (details: MermaidDetails) => Component,
): boolean {
  const segments = buildInlineRenderableSegments(text);
  const hasDiagrams = segments.some((segment) => segment.type === "diagram");
  if (!hasDiagrams) return false;

  let renderedAny = false;
  for (const segment of segments) {
    if (segment.type === "markdown") {
      const chunk = segment.text.trim();
      if (!chunk) continue;
      if (renderedAny) container.addChild(new Spacer(1));
      container.addChild(new Markdown(chunk, 1, 0, markdownTheme));
      renderedAny = true;
      continue;
    }

    if (renderedAny) container.addChild(new Spacer(1));
    container.addChild(renderInlineMermaid(segment.details));
    renderedAny = true;
  }

  return renderedAny;
}

function appendPatchedTextSegment(
  instance: AssistantMessagePatchInstance,
  text: string,
  renderInlineMermaid: (details: MermaidDetails) => Component,
): void {
  const rendered = appendAssistantTextContent(
    instance.contentContainer,
    text,
    instance.markdownTheme,
    renderInlineMermaid,
  );
  if (!rendered) {
    instance.contentContainer.addChild(new Markdown(text, 1, 0, instance.markdownTheme));
  }
}

function appendPatchedThinkingSegment(
  instance: AssistantMessagePatchInstance,
  thinking: string,
  hasVisibleContentAfter: boolean,
): void {
  if (instance.hideThinkingBlock) {
    instance.contentContainer.addChild(
      new Text(
        interactiveTheme.italic(interactiveTheme.fg("thinkingText", instance.hiddenThinkingLabel)),
        1,
        0,
      ),
    );
  } else {
    instance.contentContainer.addChild(
      new Markdown(thinking, 1, 0, instance.markdownTheme, {
        color: (text: string) => interactiveTheme.fg("thinkingText", text),
        italic: true,
      }),
    );
  }

  if (hasVisibleContentAfter) {
    instance.contentContainer.addChild(new Spacer(1));
  }
}

function appendPatchedStopReason(
  instance: AssistantMessagePatchInstance,
  message: AssistantMessage,
): void {
  const hasToolCalls = message.content.some((content) => content.type === "toolCall");
  if (hasToolCalls) {
    return;
  }

  if (message.stopReason === "aborted") {
    const abortMessage =
      hasText(message.errorMessage) && message.errorMessage !== "Request was aborted"
        ? message.errorMessage
        : "Operation aborted";
    instance.contentContainer.addChild(new Spacer(1));
    instance.contentContainer.addChild(new Text(interactiveTheme.fg("error", abortMessage), 1, 0));
    return;
  }

  if (message.stopReason === "error") {
    const errorMessage = message.errorMessage ?? "Unknown error";
    instance.contentContainer.addChild(new Spacer(1));
    instance.contentContainer.addChild(
      new Text(interactiveTheme.fg("error", `Error: ${errorMessage}`), 1, 0),
    );
  }
}

function appendPatchedMessageContent(
  instance: AssistantMessagePatchInstance,
  message: AssistantMessage,
  renderInlineMermaid: (details: MermaidDetails) => Component,
): void {
  for (let i = 0; i < message.content.length; i++) {
    const content = message.content[i];
    if (content.type === "text" && content.text.trim()) {
      appendPatchedTextSegment(instance, content.text.trim(), renderInlineMermaid);
      continue;
    }
    if (content.type !== "thinking" || !content.thinking.trim()) {
      continue;
    }

    const hasVisibleContentAfter = message.content
      .slice(i + 1)
      .some(
        (nextContent) =>
          (nextContent.type === "text" && nextContent.text.trim().length > 0) ||
          (nextContent.type === "thinking" && nextContent.thinking.trim().length > 0),
      );
    appendPatchedThinkingSegment(instance, content.thinking.trim(), hasVisibleContentAfter);
  }
}

function messageHasRenderableMermaid(message: AssistantMessage): boolean {
  return message.content.some(
    (content) =>
      content.type === "text" &&
      content.text.trim().length > 0 &&
      hasRenderableMermaid(content.text),
  );
}

function messageHasVisibleContent(message: AssistantMessage): boolean {
  return message.content.some(
    (content) =>
      (content.type === "text" && content.text.trim().length > 0) ||
      (content.type === "thinking" && content.thinking.trim().length > 0),
  );
}

function patchAssistantMessageContent(
  instance: AssistantMessagePatchInstance,
  message: AssistantMessage,
  originalUpdateContent: (message: AssistantMessage) => void,
  renderInlineMermaid: (details: MermaidDetails) => Component,
): void {
  if (!messageHasRenderableMermaid(message)) {
    originalUpdateContent.call(instance, message);
    return;
  }

  instance.lastMessage = message;
  instance.contentContainer.clear();
  if (messageHasVisibleContent(message)) {
    instance.contentContainer.addChild(new Spacer(1));
  }

  appendPatchedMessageContent(instance, message, renderInlineMermaid);
  appendPatchedStopReason(instance, message);
}

function installAssistantMessagePatch(
  renderInlineMermaid: (details: MermaidDetails) => Component,
): void {
  if (assistantPatchInstalled) return;

  const prototype = AssistantMessageComponent.prototype;
  if (Reflect.get(prototype, "__piMermaidPatched") === true) {
    assistantPatchInstalled = true;
    return;
  }

  const originalUpdateContent = Reflect.get(prototype, "updateContent");
  if (typeof originalUpdateContent !== "function") {
    throw new TypeError("AssistantMessageComponent.updateContent is unavailable");
  }

  Reflect.set(
    prototype,
    "updateContent",
    function (this: AssistantMessagePatchInstance, message: AssistantMessage): void {
      patchAssistantMessageContent(this, message, originalUpdateContent, renderInlineMermaid);
    },
  );

  Reflect.set(prototype, "__piMermaidPatched", true);
  assistantPatchInstalled = true;
}

export { installAssistantMessagePatch };
