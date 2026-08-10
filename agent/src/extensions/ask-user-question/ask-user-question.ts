import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ASK_USER_QUESTION_ANSWERED_EVENT,
  ASK_USER_QUESTION_CANCELLED_EVENT,
  ASK_USER_QUESTION_PROMPT_EVENT,
  type AskUserQuestionEventBase,
} from "./events.js";
import { renderAskUserQuestionCall, renderAskUserQuestionResult } from "./render.js";
import { displayLabel } from "./state/labels.js";
import { QuestionnaireSession } from "./state/questionnaire-session.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  type QuestionAnswer,
  type QuestionData,
  type QuestionnaireResult,
  type QuestionParams,
  QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

function buildAskUserQuestionEventBase(
  toolCallId: string,
  params: QuestionParams,
  ctx: { cwd: string; sessionManager?: { getSessionId?: () => string | undefined } },
): Omit<AskUserQuestionEventBase, "type"> {
  return {
    toolCallId,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    cwd: ctx.cwd,
    questions: params.questions.map((q) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect ?? false,
      options: q.options.map((o) => ({
        label: o.label,
        description: o.description,
        hasPreview: typeof o.preview === "string" && o.preview.length > 0,
      })),
    })),
  };
}

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const MULTI_SELECT_INSTRUCTIONS =
  "Enter one or more option labels, separated by commas or new lines.";

function questionAnswerFromRpcValue(
  question: QuestionData,
  questionIndex: number,
  value: string,
): QuestionAnswer {
  const matchedOption = question.options.find((option) => option.label === value);
  if (matchedOption !== undefined) {
    return {
      questionIndex,
      question: question.question,
      kind: "option",
      answer: value,
      ...(matchedOption.preview === undefined ? {} : { preview: matchedOption.preview }),
    };
  }
  if (value === displayLabel("chat")) {
    return { questionIndex, question: question.question, kind: "chat", answer: value };
  }
  return { questionIndex, question: question.question, kind: "custom", answer: value };
}

function multiSelectAnswerFromRpcValue(
  question: QuestionData,
  questionIndex: number,
  value: string,
): QuestionAnswer {
  const authoredLabels = new Set(question.options.map((option) => option.label));
  let submittedLabels: string[];
  try {
    const parsed: unknown = JSON.parse(value);
    submittedLabels = Array.isArray(parsed)
      ? parsed.filter((label): label is string => typeof label === "string")
      : [];
  } catch {
    submittedLabels = value.split(/[\n,]/u).map((label) => label.trim());
  }
  const selected = submittedLabels.filter((label) => authoredLabels.has(label));
  const notes = submittedLabels.filter((label) => !authoredLabels.has(label)).join(", ");
  return {
    questionIndex,
    question: question.question,
    kind: "multi",
    answer: null,
    selected,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

async function runRpcQuestionnaire(
  params: QuestionParams,
  ctx: ExtensionContext,
): Promise<QuestionnaireResult> {
  const answers: QuestionAnswer[] = [];
  for (const [questionIndex, question] of params.questions.entries()) {
    let answer: QuestionAnswer | undefined;
    if (question.options.length === 0) {
      const value = await ctx.ui.input(question.question);
      if (value !== undefined) {
        answer = questionAnswerFromRpcValue(question, questionIndex, value);
      }
    } else if (question.multiSelect === true) {
      const optionList = question.options
        .map((option) => `- ${option.label}: ${option.description}`)
        .join("\n");
      const value = await ctx.ui.editor(
        `${question.question}\n\n${optionList}\n\n${MULTI_SELECT_INSTRUCTIONS} Enter "${displayLabel("chat")}" to continue in chat instead.`,
        "",
      );
      if (value !== undefined) {
        answer =
          value.trim() === displayLabel("chat")
            ? questionAnswerFromRpcValue(question, questionIndex, value.trim())
            : multiSelectAnswerFromRpcValue(question, questionIndex, value);
      }
    } else if (question.options.some((option) => option.preview !== undefined)) {
      const optionList = question.options
        .map(
          (option) =>
            `- ${option.label}: ${option.description}${option.preview !== null && option.preview !== undefined && option.preview.length > 0 ? `\n\n${option.preview}` : ""}`,
        )
        .join("\n\n");
      const value = await ctx.ui.editor(
        `${question.question}\n\n${optionList}\n\nEnter one option label exactly, or "${displayLabel("chat")}" to continue in chat.`,
        "",
      );
      if (value !== undefined) {
        answer = questionAnswerFromRpcValue(question, questionIndex, value.trim());
      }
    } else {
      const items = buildItemsForQuestion(question);
      const value = await ctx.ui.select(question.question, [
        ...items.map((item) => item.label),
        displayLabel("chat"),
      ]);
      if (value !== undefined) {
        answer = questionAnswerFromRpcValue(question, questionIndex, value);
      }
    }
    if (answer === undefined) return { answers, cancelled: true };
    answers.push(answer);
  }
  return { answers, cancelled: false };
}

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
  const items: WrappingSelectItem[] = question.options.map((o) => ({
    kind: "option",
    label: o.label,
    description: o.description,
  }));
  const hasAnyPreview = question.options.some(
    (o) => typeof o.preview === "string" && o.preview.length > 0,
  );
  for (const kind of sentinelsToAppend(question, hasAnyPreview)) {
    items.push({ kind, label: displayLabel(kind) });
  }
  return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
  `Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
  "Reserve ask_user_question for decisions where the user's answer changes what you do next. Do not use it for choices with conventional defaults or facts you can verify yourself; pick the obvious default, mention it, and proceed.",
  'Before asking, do brief read-only investigation when possible so the question is specific. "I found X and Y; which should I use?" is better than "what should I use?".',
  'Do not ask approval-style questions like "should I proceed?" unless the next action is risky, irreversible, outward-facing, or genuinely blocked on user consent.',
  `Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs.`,
  `Set multiSelect: true when multiple answers are valid; this suppresses the "Type something." row. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. NOTE: any non-empty preview on a single-select question ALSO suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the escape hatch. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
  "Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every single-select question) or pick "Chat about this" to abandon the questionnaire and continue in free-form conversation. Do NOT author "Other" / "Type something." / "Chat about this" labels yourself — duplicates are rejected at runtime.
- Use multiSelect: true to allow multiple answers to be selected for a question. The "Type something." row is suppressed on multi-select questions, and is ALSO suppressed on single-select questions where any option carries a \`preview\` (the side-by-side layout has no room for inline custom text — "Chat about this" remains as the free-form escape hatch).
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).

${DEFAULT_PROMPT_GUIDELINES.join("\n")}`,
    parameters: QuestionParamsSchema,
    executionMode: "sequential",
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderAskUserQuestionCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderAskUserQuestionResult(result, options, theme, context);
    },

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const typed = Value.Parse(QuestionParamsSchema, params);
      if (!ctx.hasUI)
        return {
          ...buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" }),
          isError: true,
        };

      const validation = validateQuestionnaire(typed);
      if (!validation.ok) {
        return {
          ...buildToolResult(validation.message, {
            answers: [],
            cancelled: true,
            error: validation.error,
          }),
          isError: true,
        };
      }

      const eventBase = buildAskUserQuestionEventBase(toolCallId, typed, ctx);
      pi.events.emit(ASK_USER_QUESTION_PROMPT_EVENT, { type: "prompt", ...eventBase });

      const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) =>
        buildItemsForQuestion(q),
      );

      const result =
        ctx.mode === "rpc"
          ? await runRpcQuestionnaire(typed, ctx)
          : await ctx.ui.custom<QuestionnaireResult>(
              (tui, theme, _kb, done) => {
                const session = new QuestionnaireSession({
                  tui,
                  theme,
                  params: typed,
                  itemsByTab,
                  done,
                });
                return session.component;
              },
              {
                overlay: true,
                overlayOptions: {
                  anchor: "bottom-center",
                  width: "100%",
                  maxHeight: "100%",
                  margin: { left: 0, right: 0, bottom: 0 },
                },
              },
            );

      if (result?.cancelled || result === null || result === undefined) {
        pi.events.emit(ASK_USER_QUESTION_CANCELLED_EVENT, {
          type: "cancelled",
          ...eventBase,
          answers: result?.answers ?? [],
          error: result?.error,
        });
      } else {
        pi.events.emit(ASK_USER_QUESTION_ANSWERED_EVENT, {
          type: "answered",
          ...eventBase,
          answers: result.answers,
        });
      }

      return buildQuestionnaireResponse(result, typed);
    },
  });
}

export { buildQuestionnaireResponse, buildToolResult };
