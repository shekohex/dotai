import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { createTextComponent, formatToolRail, getTextContent } from "../coreui/tools.js";
import { formatAnswerScalar } from "./tool/format-answer.js";
import {
  QuestionParamsSchema,
  type QuestionAnswer,
  type QuestionParams,
  type QuestionnaireResult,
} from "./tool/types.js";

interface AskUserQuestionRenderContext {
  isError: boolean;
  isPartial: boolean;
  lastComponent: unknown;
  state?: AskUserQuestionRenderState;
}

interface AskUserQuestionRenderState {
  callComponent?: Text;
}

type AskUserQuestionStatus = "asking" | "asked" | "cancelled" | "failed";

function parseQuestionParams(value: unknown): QuestionParams | undefined {
  return Value.Check(QuestionParamsSchema, value)
    ? Value.Parse(QuestionParamsSchema, value)
    : undefined;
}

function parseQuestionnaireResult(value: unknown): QuestionnaireResult | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (!("answers" in value) || !("cancelled" in value)) return undefined;
  if (!Array.isArray(value.answers) || typeof value.cancelled !== "boolean") return undefined;
  return {
    answers: value.answers.filter(isQuestionAnswer),
    cancelled: value.cancelled,
  };
}

function isQuestionAnswer(value: unknown): value is QuestionAnswer {
  if (value === null || typeof value !== "object") return false;
  if (!("questionIndex" in value) || typeof value.questionIndex !== "number") return false;
  if (!("question" in value) || typeof value.question !== "string") return false;
  if (!("kind" in value) || typeof value.kind !== "string") return false;
  if (!["option", "custom", "chat", "multi"].includes(value.kind)) return false;
  return "answer" in value && (typeof value.answer === "string" || value.answer === null);
}

function questionCountLabel(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}

function answeredCountLabel(answeredCount: number, questionCount: number): string {
  return `${answeredCount}/${questionCount} answered`;
}

function statusColor(status: AskUserQuestionStatus): "dim" | "success" | "error" {
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "asked") return "success";
  return "dim";
}

function statusLabel(status: AskUserQuestionStatus): string {
  switch (status) {
    case "asking":
      return "asking";
    case "asked":
      return "asked";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default: {
      const _unreachable: never = status;
      return _unreachable;
    }
  }
}

function resultStatus(input: {
  isError: boolean;
  cancelled: boolean | undefined;
}): AskUserQuestionStatus {
  if (input.isError) return "failed";
  if (input.cancelled === true) return "cancelled";
  return "asked";
}

function headerLine(input: {
  status: AskUserQuestionStatus;
  questionCount: number;
  answeredCount?: number;
  theme: Theme;
  context: AskUserQuestionRenderContext;
}): string {
  const rail = formatToolRail(input.theme, input.context);
  const icon = input.theme.bold(input.theme.fg(statusColor(input.status), "?"));
  const status = input.theme.bold(
    input.theme.fg(statusColor(input.status), statusLabel(input.status)),
  );
  const count = input.theme.fg("muted", questionCountLabel(input.questionCount));
  const answered =
    input.answeredCount === undefined
      ? ""
      : ` ${input.theme.fg("dim", "·")} ${input.theme.fg("muted", answeredCountLabel(input.answeredCount, input.questionCount))}`;
  return `${rail}${icon} ${status} ${count}${answered}`;
}

function expandedQuestionLines(
  params: QuestionParams | undefined,
  answers: readonly QuestionAnswer[],
  theme: Theme,
  rail: string,
): string[] {
  const questions = params?.questions ?? [];
  if (questions.length === 0 && answers.length === 0)
    return [`${rail}${theme.fg("dim", "No questions")}`];
  const lines: string[] = [];
  const count = Math.max(questions.length, answers.length);
  for (let index = 0; index < count; index += 1) {
    const answer = answers.find((item) => item.questionIndex === index);
    const question = questions[index]?.question ?? answer?.question ?? `Question ${index + 1}`;
    lines.push(`${rail}${theme.fg("muted", question)}`);
    if (answer === undefined) {
      lines.push(`${rail}${theme.fg("dim", "not answered")}`);
    } else {
      lines.push(`${rail}${theme.fg("dim", formatAnswerScalar(answer, "summary"))}`);
    }
  }
  return lines;
}

export function renderAskUserQuestionCall(
  args: unknown,
  theme: Theme,
  context: AskUserQuestionRenderContext,
) {
  const params = parseQuestionParams(args);
  const questionCount = params?.questions.length ?? 0;
  const component = createTextComponent(
    context.lastComponent,
    headerLine({ status: "asking", questionCount, theme, context }),
  );
  if (context.state !== undefined) {
    context.state.callComponent = component;
  }
  return component;
}

function updateCallComponent(
  state: AskUserQuestionRenderState | undefined,
  fallbackComponent: unknown,
  header: string,
): boolean {
  const component = state?.callComponent ?? fallbackComponent;
  if (!(component instanceof Text)) return false;
  component.setText(header);
  return true;
}

export function renderAskUserQuestionResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: AskUserQuestionRenderContext & { args?: unknown },
) {
  const params = parseQuestionParams(context.args);
  const details = parseQuestionnaireResult(result.details);
  const questionCount = params?.questions.length ?? details?.answers.length ?? 0;
  const answeredCount = details?.answers.length ?? 0;
  const status = resultStatus({ isError: context.isError, cancelled: details?.cancelled });
  const header = headerLine({ status, questionCount, answeredCount, theme, context });
  const updatedCall = updateCallComponent(context.state, context.lastComponent, header);
  if (!options.expanded) {
    return createTextComponent(context.lastComponent, updatedCall ? "" : header);
  }

  const rail = formatToolRail(theme, context);
  const answerLines = expandedQuestionLines(params, details?.answers ?? [], theme, rail);
  const errorText = context.isError ? getTextContent(result).trim() : "";
  const errorLines = errorText.length === 0 ? [] : [`${rail}${theme.fg("error", errorText)}`];
  const lines = updatedCall
    ? [...answerLines, ...errorLines]
    : [header, ...answerLines, ...errorLines];
  return createTextComponent(context.lastComponent, lines.join("\n"));
}
