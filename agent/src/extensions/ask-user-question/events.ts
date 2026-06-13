import type { QuestionAnswer } from "./tool/types.js";
import { Type } from "typebox";
import { Value } from "typebox/value";

// Internal extension events follow repo convention: `<extension>:<phase>`.
// Payloads are JSON-safe because pi-osc forwards them to terminal OSC later.
export const ASK_USER_QUESTION_PROMPT_EVENT = "ask-user-question:prompt" as const;
export const ASK_USER_QUESTION_ANSWERED_EVENT = "ask-user-question:answered" as const;
export const ASK_USER_QUESTION_CANCELLED_EVENT = "ask-user-question:cancelled" as const;

export interface AskUserQuestionEventBase {
  type: "prompt" | "answered" | "cancelled";
  toolCallId: string;
  sessionId?: string;
  cwd: string;
  questions: ReadonlyArray<AskUserQuestionEventQuestion>;
  glanceUploadUrl?: string;
}

export interface AskUserQuestionPromptEventPayload extends AskUserQuestionEventBase {
  type: "prompt";
}

export interface AskUserQuestionAnsweredEventPayload extends AskUserQuestionEventBase {
  type: "answered";
  answers: ReadonlyArray<QuestionAnswer>;
}

export interface AskUserQuestionCancelledEventPayload extends AskUserQuestionEventBase {
  type: "cancelled";
  answers: ReadonlyArray<QuestionAnswer>;
  error?: string;
}

export interface AskUserQuestionEventQuestion {
  // Full question text exactly as authored by agent.
  question: string;
  // Short chip/tag shown in TUI tab/header.
  header: string;
  // True when user can pick multiple authored options.
  multiSelect: boolean;
  screenshotPrompt?: string;
  options: ReadonlyArray<AskUserQuestionOption>;
}

export interface AskUserQuestionOption {
  label: string;
  description: string;
  // Preview text can be large; event only exposes presence for notifications.
  hasPreview: boolean;
}

export type AskUserPromptEventPayload = AskUserQuestionPromptEventPayload;

const AskUserQuestionOptionEventSchema = Type.Object(
  {
    label: Type.String(),
    description: Type.String(),
    hasPreview: Type.Boolean(),
  },
  { additionalProperties: false },
);

const AskUserQuestionEventQuestionSchema = Type.Object(
  {
    question: Type.String(),
    header: Type.String(),
    multiSelect: Type.Boolean(),
    screenshotPrompt: Type.Optional(Type.String()),
    options: Type.Array(AskUserQuestionOptionEventSchema),
  },
  { additionalProperties: false },
);

const AskUserQuestionEventSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("prompt"), Type.Literal("answered"), Type.Literal("cancelled")]),
    toolCallId: Type.String(),
    sessionId: Type.Optional(Type.String()),
    cwd: Type.String(),
    glanceUploadUrl: Type.Optional(Type.String()),
    questions: Type.Array(AskUserQuestionEventQuestionSchema),
    answers: Type.Optional(Type.Array(Type.Unknown())),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type AskUserQuestionEventPayload =
  | AskUserQuestionPromptEventPayload
  | AskUserQuestionAnsweredEventPayload
  | AskUserQuestionCancelledEventPayload;

export const isAskUserQuestionEventPayload = (
  value: unknown,
): value is AskUserQuestionEventPayload => Value.Check(AskUserQuestionEventSchema, value);
