import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ensureGlanceDaemon,
  startGlanceHeartbeat,
  type GlanceHeartbeatHandle,
} from "../glance/daemon.js";
import { getGlancePaths } from "../glance/paths.js";
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
  glanceUploadUrl?: string,
): Omit<AskUserQuestionEventBase, "type"> {
  return {
    toolCallId,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    cwd: ctx.cwd,
    ...(glanceUploadUrl === undefined ? {} : { glanceUploadUrl }),
    questions: params.questions.map((q) => ({
      question: q.question,
      header: q.header,
      multiSelect: q.multiSelect ?? false,
      ...(q.screenshotRequest === undefined
        ? {}
        : { screenshotPrompt: q.screenshotRequest.prompt }),
      options: q.options.map((o) => ({
        label: o.label,
        description: o.description,
        hasPreview: typeof o.preview === "string" && o.preview.length > 0,
      })),
    })),
  };
}

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const hasScreenshotRequest = (params: QuestionParams): boolean =>
  params.questions.some((question) => question.screenshotRequest !== undefined);

const joinGlanceUrl = (baseUrl: string, path: string): string => {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBaseUrl).toString();
};

const createScreenshotQuestionText = (
  question: QuestionData,
  glanceUploadUrl: string | undefined,
): string => {
  if (question.screenshotRequest === undefined) return question.question;
  if (glanceUploadUrl === undefined) {
    return `${question.question}\n\nScreenshot requested: ${question.screenshotRequest.prompt}. Glance upload URL is unavailable; paste screenshot path(s) if you already have them.`;
  }
  return `${question.question}\n\nScreenshot requested: ${question.screenshotRequest.prompt}. Upload via ${glanceUploadUrl}, then paste returned file path(s) in your answer.`;
};

const withScreenshotQuestionText = (
  params: QuestionParams,
  glanceUploadUrl: string | undefined,
): QuestionParams => ({
  questions: params.questions.map((question) => ({
    ...question,
    question: createScreenshotQuestionText(question, glanceUploadUrl),
  })),
});

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
  `Each normal choice question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Screenshot/image requests MUST be their own separate question with screenshotRequest and exactly options: [] so the user gets only a free-text path input. Do NOT combine screenshotRequest with choice options. If you need choices and a screenshot, ask two questions in the same invocation: one normal options question, one screenshotRequest question with options: []. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs.`,
  `Set multiSelect: true when multiple answers are valid; this suppresses the "Type something." row. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. NOTE: any non-empty preview on a single-select question ALSO suppresses the "Type something." row (no room in the side-by-side layout); "Chat about this" remains the escape hatch. If you recommend a specific option, make it the first option and append "(Recommended)" to its label.`,
  "Set question.screenshotRequest with options: [] when the answer requires a screenshot/image from the user. This question is free-text only; do not provide options or multiSelect. Glance starts automatically, the UI shows the upload URL, and the user pastes returned file path(s) in the normal answer text.",
  "Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
  const glancePaths = getGlancePaths();
  let glanceHeartbeat: GlanceHeartbeatHandle | undefined;

  pi.on("session_shutdown", async () => {
    await glanceHeartbeat?.stop();
    glanceHeartbeat = undefined;
  });

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
- Use screenshotRequest: { prompt } only on a separate free-text question with options: [] when the user needs to upload a screenshot/image. Glance starts automatically and the question UI shows the upload URL. The user uploads there and pastes returned local file path(s) in the normal answer text. Never combine screenshotRequest with choice options or multiSelect. If you need both a decision and a screenshot, ask two questions in the same call.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`,
    promptSnippet: DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
    parameters: QuestionParamsSchema,
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

      let glanceUploadUrl: string | undefined;
      if (hasScreenshotRequest(typed)) {
        glanceHeartbeat ??= await startGlanceHeartbeat({ paths: glancePaths, cwd: ctx.cwd });
        const status = await ensureGlanceDaemon({ paths: glancePaths });
        glanceUploadUrl = joinGlanceUrl(status.publicBaseUrl ?? status.baseUrl, "upload");
      }

      const displayParams = withScreenshotQuestionText(typed, glanceUploadUrl);
      const eventBase = buildAskUserQuestionEventBase(toolCallId, typed, ctx, glanceUploadUrl);
      pi.events.emit(ASK_USER_QUESTION_PROMPT_EVENT, { type: "prompt", ...eventBase });

      const itemsByTab: WrappingSelectItem[][] = displayParams.questions.map((q) =>
        buildItemsForQuestion(q),
      );

      const result = await ctx.ui.custom<QuestionnaireResult>(
        (tui, theme, _kb, done) => {
          const session = new QuestionnaireSession({
            tui,
            theme,
            params: displayParams,
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
