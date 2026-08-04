import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  renderSubagentParentMessageCall,
  renderSubagentParentMessageResult,
  type SubagentParentMessageRenderState,
} from "./parent-message-render.js";
import {
  SubagentParentMessageToolParamsSchema,
  type SubagentParentMessage,
} from "./parent-message-types.js";

export {
  parseSubagentParentMessage,
  SubagentParentMessageKindSchema,
  SubagentParentMessageSchema,
  SubagentParentMessageToolParamsSchema,
  type SubagentParentMessage,
  type SubagentParentMessageKind,
  type SubagentParentMessageToolParams,
} from "./parent-message-types.js";

export const SUBAGENT_PARENT_MESSAGE_TYPE = "subagent-parent-message";

export function createSubagentParentMessageTool(send: (message: SubagentParentMessage) => void) {
  return defineTool<
    typeof SubagentParentMessageToolParamsSchema,
    SubagentParentMessage,
    SubagentParentMessageRenderState
  >({
    name: "subagent",
    label: "π",
    renderShell: "self",
    description:
      "Message the parent session from this child thread. Use explicit, concise updates for blockers, decisions, questions, material progress, or results. Messages steer the parent immediately by default. Routine token progress already streams automatically; do not spam or expose raw chain-of-thought.",
    parameters: SubagentParentMessageToolParamsSchema,
    renderCall: renderSubagentParentMessageCall,
    renderResult: renderSubagentParentMessageResult,
    execute(_toolCallId, params) {
      const message: SubagentParentMessage = {
        kind: params.kind ?? "commentary",
        message: params.message,
        delivery: params.delivery ?? "steer",
        createdAt: Date.now(),
      };
      send(message);
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text:
              message.delivery === "steer"
                ? "Message steered parent session."
                : "Message queued for parent session follow-up.",
          },
        ],
        details: message,
      });
    },
  });
}
