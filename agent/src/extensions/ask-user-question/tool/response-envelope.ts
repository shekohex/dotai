import { formatAnswerScalar } from "./format-answer.js";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.js";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

/**
 * Map questionnaire output to the LLM-facing tool result envelope.
 *
 * @param {QuestionnaireResult | null | undefined} result Questionnaire result returned by TUI.
 * @param {QuestionParams} params Original questionnaire params.
 * @returns {object} Tool result object for model consumption.
 */
export function buildQuestionnaireResponse(
  result: QuestionnaireResult | null | undefined,
  params: QuestionParams,
) {
  if (result === null || result === undefined || result.cancelled) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result?.answers ?? [],
      cancelled: true,
    });
  }

  const segments: string[] = [];
  for (let index = 0; index < params.questions.length; index += 1) {
    const answer = result.answers.find((item) => item.questionIndex === index);
    if (answer !== undefined) segments.push(buildAnswerSegment(answer));
  }
  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result.answers,
      cancelled: true,
    });
  }
  return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}

/**
 * Format a single answer segment for the envelope.
 *
 * @param {QuestionAnswer} answer The question answer.
 * @returns {string} Formatted answer segment string.
 */
export function buildAnswerSegment(answer: QuestionAnswer): string {
  const parts: string[] = [`"${answer.question}"="${formatAnswerScalar(answer, "envelope")}"`];
  if (answer.preview !== undefined && answer.preview.length > 0) {
    parts.push(`selected preview: ${answer.preview}`);
  }
  if (answer.notes !== undefined && answer.notes.length > 0) {
    parts.push(`user notes: ${answer.notes}`);
  }
  return `${parts.join(". ")}.`;
}

/**
 * Build the common tool result shape.
 *
 * @param {string} text Text response visible to the model.
 * @param {QuestionnaireResult} details Structured questionnaire details.
 * @returns {object} Tool result object.
 */
export function buildToolResult(text: string, details: QuestionnaireResult) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}
