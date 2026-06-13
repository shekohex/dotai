import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

export {
  ASK_USER_QUESTION_ANSWERED_EVENT,
  ASK_USER_QUESTION_CANCELLED_EVENT,
  ASK_USER_QUESTION_PROMPT_EVENT,
  type AskUserQuestionAnsweredEventPayload,
  type AskUserQuestionCancelledEventPayload,
  type AskUserQuestionEventQuestion,
  type AskUserQuestionOption,
  type AskUserQuestionPromptEventPayload,
  type AskUserPromptEventPayload,
} from "./events.js";

export default function (pi: ExtensionAPI) {
  registerAskUserQuestionTool(pi);
}
