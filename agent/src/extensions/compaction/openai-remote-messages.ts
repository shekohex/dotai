import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { asRecord } from "../../utils/unknown-data.js";
import { readAssistantTextPhase } from "../../utils/pi-ai-text.js";
import type { AssistantPhase, ResponseContentItem, ResponseItem } from "./openai-remote-types.js";

const IMAGE_CONTENT_OMITTED_PLACEHOLDER =
  "image content omitted because you do not support image input";
const RETAINED_MESSAGE_TOKEN_BUDGET = 20_000;

const ReasoningSignatureSchema = Type.Object(
  {
    type: Type.Literal("reasoning"),
    summary: Type.Optional(
      Type.Array(Type.Object({ text: Type.String() }, { additionalProperties: true })),
    ),
    content: Type.Optional(
      Type.Array(
        Type.Object(
          { type: Type.Optional(Type.String()), text: Type.String() },
          { additionalProperties: true },
        ),
      ),
    ),
    encrypted_content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

const UnknownArraySchema = Type.Array(Type.Unknown());

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseThinkingSignature(value: string | undefined): ResponseItem | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = parseJson(value);
  if (!Value.Check(ReasoningSignatureSchema, parsed)) return undefined;
  const reasoning = Value.Parse(ReasoningSignatureSchema, parsed);
  const summary = (reasoning.summary ?? []).map((item) => ({
    type: "summary_text",
    text: item.text,
  }));
  const content = reasoning.content?.map((item) => ({
    type: item.type === "reasoning_text" ? "reasoning_text" : "text",
    text: item.text,
  }));

  return {
    type: "reasoning",
    summary,
    ...(content !== undefined && content.length > 0 ? { content } : {}),
    encrypted_content: reasoning.encrypted_content ?? null,
  };
}

function userContentToResponseItems(content: UserMessage["content"]): ResponseContentItem[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "input_text", text: content }] : [];
  }

  return content.map((part) => contentPartToResponseItem(part));
}

function contentPartToResponseItem(
  part: TextContent | ImageContent,
): Extract<ResponseContentItem, { type: "input_text" | "input_image" }> {
  if (part.type === "text") return { type: "input_text", text: part.text };
  return {
    type: "input_image",
    image_url: `data:${part.mimeType};base64,${part.data}`,
  };
}

function toolResultOutput(content: ToolResultMessage["content"]): ResponseContentItem[] {
  return content.map((part) => contentPartToResponseItem(part));
}

function assistantMessageToResponseItems(message: AssistantMessage): ResponseItem[] {
  const items: ResponseItem[] = [];
  let phase: AssistantPhase | undefined;
  let textBlocks: string[] = [];

  const flushText = (): void => {
    if (textBlocks.length === 0) return;
    items.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: textBlocks.join("") }],
      ...(phase === undefined ? {} : { phase }),
    });
    textBlocks = [];
  };

  for (const block of message.content) {
    if (block.type === "text") {
      phase ??= readAssistantTextPhase(block);
      textBlocks.push(block.text);
      continue;
    }
    if (block.type === "thinking") {
      flushText();
      const reasoning = parseThinkingSignature(block.thinkingSignature);
      if (reasoning !== undefined) items.push(reasoning);
      continue;
    }

    flushText();
    items.push({
      type: "function_call",
      name: block.name,
      call_id: block.id.split("|", 1)[0] ?? block.id,
      arguments: JSON.stringify(block.arguments),
    });
  }

  flushText();
  return items;
}

export function messageToResponseItems(message: AgentMessage): ResponseItem[] {
  if (message.role === "user") {
    const content = userContentToResponseItems(message.content);
    return content.length === 0 ? [] : [{ type: "message", role: "user", content }];
  }
  if (message.role === "assistant") return assistantMessageToResponseItems(message);
  if (message.role === "toolResult") {
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId.split("|", 1)[0] ?? message.toolCallId,
        output: toolResultOutput(message.content),
      },
    ];
  }
  return [];
}

export function messagesToResponseItems(messages: AgentMessage[]): ResponseItem[] {
  return messages.flatMap((message) => messageToResponseItems(message));
}

function cloneResponseItem(item: ResponseItem): ResponseItem {
  return structuredClone(item);
}

function responseItemCallId(item: ResponseItem): string | undefined {
  return typeof item.call_id === "string" && item.call_id.length > 0 ? item.call_id : undefined;
}

function outputTypeForCallType(type: string): string | undefined {
  if (type === "function_call" || type === "local_shell_call") {
    return "function_call_output";
  }
  if (type === "tool_search_call") return "tool_search_output";
  if (type === "custom_tool_call") return "custom_tool_call_output";
  return undefined;
}

function syntheticOutputForCall(item: ResponseItem): ResponseItem | undefined {
  const callId = responseItemCallId(item);
  if (callId === undefined) return undefined;
  if (item.type === "function_call" || item.type === "local_shell_call") {
    return { type: "function_call_output", call_id: callId, output: "aborted" };
  }
  if (item.type === "tool_search_call") {
    return {
      type: "tool_search_output",
      call_id: callId,
      status: "completed",
      execution: "client",
      tools: [],
    };
  }
  if (item.type === "custom_tool_call") {
    return { type: "custom_tool_call_output", call_id: callId, output: "aborted" };
  }
  return undefined;
}

function ensureCallOutputsPresent(items: ResponseItem[]): ResponseItem[] {
  const normalized: ResponseItem[] = [];
  for (const item of items) {
    normalized.push(item);
    const outputType = outputTypeForCallType(item.type);
    const callId = responseItemCallId(item);
    if (outputType === undefined || callId === undefined) continue;
    const hasOutput = items.some(
      (candidate) => candidate.type === outputType && responseItemCallId(candidate) === callId,
    );
    if (hasOutput) continue;
    const synthetic = syntheticOutputForCall(item);
    if (synthetic !== undefined) normalized.push(synthetic);
  }
  return normalized;
}

function removeOrphanOutputs(items: ResponseItem[]): ResponseItem[] {
  const functionCallIds = new Set<string>();
  const toolSearchCallIds = new Set<string>();
  const customToolCallIds = new Set<string>();

  for (const item of items) {
    const callId = responseItemCallId(item);
    if (callId === undefined) continue;
    if (item.type === "function_call" || item.type === "local_shell_call") {
      functionCallIds.add(callId);
    } else if (item.type === "tool_search_call") {
      toolSearchCallIds.add(callId);
    } else if (item.type === "custom_tool_call") {
      customToolCallIds.add(callId);
    }
  }

  return items.filter((item) => {
    const callId = responseItemCallId(item);
    if (item.type === "function_call_output") {
      return callId !== undefined && functionCallIds.has(callId);
    }
    if (item.type === "custom_tool_call_output") {
      return callId !== undefined && customToolCallIds.has(callId);
    }
    if (item.type === "tool_search_output") {
      return item.execution === "server" || callId === undefined || toolSearchCallIds.has(callId);
    }
    return true;
  });
}

function modelSupportsImages(model: Model<Api>): boolean {
  return model.input.includes("image");
}

function parseUnknownArray(value: unknown): unknown[] | undefined {
  return Value.Check(UnknownArraySchema, value)
    ? Value.Parse(UnknownArraySchema, value)
    : undefined;
}

function replaceImageContent(content: unknown[]): unknown[] {
  return content.map((value) => {
    const item = asRecord(value);
    return item?.type === "input_image"
      ? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER }
      : value;
  });
}

function stripUnsupportedFunctionOutputImages(output: unknown): unknown {
  const arrayOutput = parseUnknownArray(output);
  if (arrayOutput !== undefined) return replaceImageContent(arrayOutput);
  const objectOutput = asRecord(output);
  if (objectOutput === undefined) return output;
  const content = parseUnknownArray(objectOutput.content);
  return content === undefined
    ? output
    : { ...objectOutput, content: stripUnsupportedFunctionOutputImages(content) };
}

function stripUnsupportedImages(item: ResponseItem): ResponseItem {
  const next = cloneResponseItem(item);
  const messageContent = parseUnknownArray(next.content);
  if (next.type === "message" && messageContent !== undefined) {
    next.content = replaceImageContent(messageContent);
  }
  if (
    (next.type === "function_call_output" || next.type === "custom_tool_call_output") &&
    next.output !== undefined
  ) {
    next.output = stripUnsupportedFunctionOutputImages(next.output);
  }
  if (next.type === "image_generation_call" && typeof next.result === "string") {
    next.result = "";
  }
  return next;
}

export function normalizeResponseItemsForPrompt(
  items: ResponseItem[],
  model: Model<Api>,
): ResponseItem[] {
  const withoutGhostSnapshots = items
    .filter((item) => item.type !== "ghost_snapshot")
    .map((item) => cloneResponseItem(item));
  const withCallOutputs = ensureCallOutputsPresent(withoutGhostSnapshots);
  const withoutOrphanOutputs = removeOrphanOutputs(withCallOutputs);
  return modelSupportsImages(model)
    ? withoutOrphanOutputs
    : withoutOrphanOutputs.map((item) => stripUnsupportedImages(item));
}

function responseMessageText(item: ResponseItem): string {
  const content = parseUnknownArray(item.content);
  if (item.type !== "message" || content === undefined) return "";
  return content
    .map((value) => {
      const part = asRecord(value);
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("");
}

function isRealUserMessage(item: ResponseItem): boolean {
  if (item.type !== "message" || item.role !== "user") return false;
  if (typeof item.content === "string") return item.content.trim().length > 0;
  const content = parseUnknownArray(item.content);
  return content !== undefined && content.length > 0;
}

function approximateMessageTokens(item: ResponseItem): number {
  return Math.max(1, Math.ceil(responseMessageText(item).length / 4));
}

function truncateMessageToTokenBudget(
  item: ResponseItem,
  maxTokens: number,
): ResponseItem | undefined {
  const itemContent = parseUnknownArray(item.content);
  if (item.type !== "message" || itemContent === undefined) return cloneResponseItem(item);
  let remainingCharacters = Math.max(0, maxTokens * 4);
  const content = itemContent.flatMap((value) => {
    const part = asRecord(value);
    if (part === undefined) return [];
    if (part.type === "input_image") return [part];
    if (typeof part.text !== "string" || remainingCharacters === 0) {
      return [];
    }
    const text = part.text.slice(0, remainingCharacters);
    remainingCharacters -= text.length;
    return text.length > 0 ? [{ ...part, text }] : [];
  });
  return content.length > 0 ? { ...cloneResponseItem(item), content } : undefined;
}

function truncateRetainedMessages(items: ResponseItem[], maxTokens: number): ResponseItem[] {
  let remainingTokens = maxTokens;
  const retainedReversed: ResponseItem[] = [];
  for (const item of items.toReversed()) {
    if (remainingTokens === 0) break;
    const tokenCount = approximateMessageTokens(item);
    if (tokenCount <= remainingTokens) {
      retainedReversed.push(cloneResponseItem(item));
      remainingTokens -= tokenCount;
      continue;
    }
    const truncated = truncateMessageToTokenBudget(item, remainingTokens);
    if (truncated !== undefined) retainedReversed.push(truncated);
    remainingTokens = 0;
  }
  return retainedReversed.toReversed();
}

export function buildRemoteCompactionHistory(
  input: ResponseItem[],
  compactionItem: ResponseItem,
): ResponseItem[] {
  if (compactionItem.type !== "compaction") {
    throw new Error("OpenAI remote compaction did not return a compaction item.");
  }
  const retainedUserMessages = input.filter((item) => isRealUserMessage(item));
  return [
    ...truncateRetainedMessages(retainedUserMessages, RETAINED_MESSAGE_TOKEN_BUDGET),
    cloneResponseItem(compactionItem),
  ];
}
