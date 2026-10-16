import { z } from "zod";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { mentionsOpenUi, isRenderToolName, renderCall, renderCallSchema, type RenderCall } from "../shared/render";
import { parseAnswer, answerSchema, type Answer } from "../shared/answer";
import { AnswerCard } from "./answer";
import { hasFence } from "../shared/fence";
import { messageData, messageSchema, type MessageData } from "../shared/message";
import { isSetup } from "../shared/attach";
import { MessageView, SetupCard } from "./message";
import { RenderCardBody } from "./render-card";
import { NodeBoundary } from "./runtime";

const KIND = "openui-render";
const ANSWER_KIND = "openui-answer";
const MESSAGE_KIND = "openui-message";
const SETUP_KIND = "openui-setup";

function RenderCard(props: PluginTimelineItemProps<RenderCall>) {
  return (
    <NodeBoundary name="render card">
      <RenderCardBody {...props} />
    </NodeBoundary>
  );
}

function GuardedMessageView(props: PluginTimelineItemProps<MessageData>) {
  return (
    <NodeBoundary name="message">
      <MessageView {...props} />
    </NodeBoundary>
  );
}

function GuardedAnswerCard(props: PluginTimelineItemProps<Answer>) {
  return (
    <NodeBoundary name="answer card">
      <AnswerCard {...props} />
    </NodeBoundary>
  );
}

export function contributeTimeline(client: PluginClientContext): void {
  client.addTimelineTransformer({
    id: "openui-render-calls",
    query: { itemType: "tool_call" },
    transform: ({ item, phase }) => {
      if (mentionsOpenUi(item.name) && !isRenderToolName(item.name)) {
        console.warn(`[openui] unrecognised tool name: ${item.name}`);
      }
      const call = renderCall(item, phase);
      return call ? { items: [{ type: "plugin" as const, kind: KIND, version: 1, data: call }] } : undefined;
    },
  });
  client.addTimelineTransformer({
    id: "openui-answers",
    query: { itemType: "user_message" },
    transform: ({ item }) => {
      if (isSetup(item.text)) return { items: [{ type: "plugin" as const, kind: SETUP_KIND, version: 1, data: {} }] };
      const answer = parseAnswer(item.text);
      return answer
        ? { items: [{ type: "plugin" as const, kind: ANSWER_KIND, version: 1, data: JSON.parse(JSON.stringify(answer)) }] }
        : undefined;
    },
  });
  client.addTimelineTransformer({
    id: "openui-messages",
    query: { itemType: "assistant_message" },
    transform: ({ item, phase }) =>
      hasFence(item.text)
        ? { items: [{ type: "plugin" as const, kind: MESSAGE_KIND, version: 1, data: messageData(item.text, phase) }] }
        : undefined,
  });
  client.addTimelineRenderer({ kind: MESSAGE_KIND, version: 1, schema: messageSchema, Component: GuardedMessageView });
  client.addTimelineRenderer({ kind: SETUP_KIND, version: 1, schema: z.object({}), Component: SetupCard });
  client.addTimelineRenderer({ kind: ANSWER_KIND, version: 1, schema: answerSchema, Component: GuardedAnswerCard });
  client.addTimelineRenderer({
    kind: KIND,
    version: 1,
    schema: renderCallSchema,
    Component: RenderCard,
  });
}
