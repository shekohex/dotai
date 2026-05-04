import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { hasStringProperty } from "./guards.js";
import type { Question } from "./schema.js";
import type { AgentResponseItem, ChoiceResponseValue, ResponseItem } from "./types.js";

export function isChoiceResponseValue(value: unknown): value is ChoiceResponseValue {
  return !Array.isArray(value) && hasStringProperty(value, "option");
}

function formatChoiceWithOptionalNote(option: string, note: string | undefined): string {
  if (note === undefined) {
    return option;
  }
  return `${option} (${note})`;
}

function formatChoiceWithOptionalDetail(option: string, note: string | undefined): string {
  if (note === undefined) {
    return option;
  }
  return `${option}: ${note}`;
}

function formatResponseValue(value: ResponseItem["value"]): string {
  if (Array.isArray(value)) {
    if (value.every((item) => isChoiceResponseValue(item))) {
      return value.map((item) => formatChoiceWithOptionalNote(item.option, item.note)).join(", ");
    }
    return value.join(", ");
  }
  if (isChoiceResponseValue(value)) {
    return formatChoiceWithOptionalNote(value.option, value.note);
  }
  return value;
}

export function hasAnswerValue(value: ResponseItem["value"]): boolean {
  if (Array.isArray(value)) {
    if (value.every((item) => isChoiceResponseValue(item))) {
      return value.some((item) => item.option.trim() !== "");
    }
    return value.some((item) => item.trim() !== "");
  }
  if (isChoiceResponseValue(value)) {
    return value.option.trim() !== "";
  }
  return value.trim() !== "";
}

export function hasResponseContent(response: ResponseItem): boolean {
  return hasAnswerValue(response.value) || (response.attachments?.length ?? 0) > 0;
}

function summarizeResponseValue(question: Question, response: ResponseItem): string {
  if (question.type === "image") {
    if (Array.isArray(response.value)) {
      return response.value.length === 1
        ? "1 image attached"
        : `${response.value.length} images attached`;
    }
    if (typeof response.value === "string" && response.value.trim() !== "") {
      return "1 image attached";
    }
  }

  if (hasAnswerValue(response.value)) {
    return formatResponseValue(response.value);
  }

  const attachmentCount = response.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    return attachmentCount === 1
      ? "1 attachment included"
      : `${attachmentCount} attachments included`;
  }

  return "";
}

export function buildAnsweredAgentResponseItems(
  responses: ResponseItem[],
  questions: Question[],
): AgentResponseItem[] {
  const responseById = new Map<string, ResponseItem>();
  for (const response of responses) {
    responseById.set(response.id, response);
  }

  return questions.flatMap((question) => {
    const response = responseById.get(question.id);
    if (response === undefined || !hasResponseContent(response)) {
      return [];
    }
    return [
      {
        id: question.id,
        question: question.question,
        type: question.type,
        value: response.value,
        attachments:
          response.attachments !== undefined && response.attachments.length > 0
            ? [...response.attachments]
            : undefined,
      } satisfies AgentResponseItem,
    ];
  });
}

export function formatAnsweredResponsesForAgent(
  responses: ResponseItem[],
  questions: Question[],
): string {
  const answeredItems = buildAnsweredAgentResponseItems(responses, questions);
  if (answeredItems.length === 0) {
    return "(none)";
  }

  const questionById = new Map(questions.map((question) => [question.id, question]));
  const responseById = new Map(responses.map((response) => [response.id, response]));
  const summary = answeredItems
    .map((item) => {
      const question = questionById.get(item.id);
      const response = responseById.get(item.id);
      if (question === undefined || response === undefined) {
        return `- ${item.question}`;
      }
      const attachments =
        item.attachments !== undefined && item.attachments.length > 0
          ? ` [attachments: ${item.attachments.join(", ")}]`
          : "";
      return `- ${item.question}: ${summarizeResponseValue(question, response)}${attachments}`;
    })
    .join("\n");

  return `${summary}\n\nStructured response data:\n\n\`\`\`json\n${JSON.stringify(answeredItems, null, 2)}\n\`\`\``;
}

export function hasAnyAnswers(responses: ResponseItem[]): boolean {
  return responses.some((response) => hasResponseContent(response));
}

export function filterAnsweredResponses(responses: ResponseItem[]): ResponseItem[] {
  return responses.filter((response) => hasResponseContent(response));
}

export function formatInterviewProgressMessage(
  responses: ResponseItem[],
  questions: Question[],
): string {
  const answered = buildAnsweredAgentResponseItems(responses, questions);
  return answered.length === 0 ? "waiting for answers" : `${answered.length} answered`;
}

export function getInterviewQuestionCount(questions: Question[]): number {
  return questions.filter((question) => question.type !== "info").length;
}

export function formatInterviewCountSummary(answeredCount: number, totalQuestions: number): string {
  return `${answeredCount}/${totalQuestions} ${answeredCount === 1 ? "response" : "responses"}`;
}

export function summarizeInterviewAnswerValue(value: ResponseItem["value"]): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "(empty)";
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "(none)";
    }

    return value
      .map((item) =>
        typeof item === "string" ? item : formatChoiceWithOptionalDetail(item.option, item.note),
      )
      .join(", ");
  }

  return formatChoiceWithOptionalDetail(value.option, value.note);
}

export function hasQueuedMessages(ctx: ExtensionContext): boolean {
  return ctx.hasPendingMessages();
}
