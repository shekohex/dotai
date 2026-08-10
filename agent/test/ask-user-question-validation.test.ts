import { expect, test } from "vitest";
import { Value } from "typebox/value";
import { validateQuestionnaire } from "../src/extensions/ask-user-question/tool/validate-questionnaire.js";
import {
  MIN_OPTIONS,
  QuestionParamsSchema,
} from "../src/extensions/ask-user-question/tool/types.js";

test("normal choice questions are accepted without screenshot fields", () => {
  expect(
    validateQuestionnaire({
      questions: [
        {
          question: "Which path should we take?",
          header: "Path",
          options: [
            { label: "Fast", description: "Ship quickly" },
            { label: "Safe", description: "Reduce risk" },
          ],
        },
      ],
    }),
  ).toEqual({ ok: true });
});

test("question schema does not expose or accept screenshot requests", () => {
  const questionSchema = QuestionParamsSchema.properties.questions.items;

  expect(questionSchema.properties).not.toHaveProperty("screenshotRequest");
  expect(questionSchema.properties.options.minItems).toBe(MIN_OPTIONS);
  expect(
    Value.Check(QuestionParamsSchema, {
      questions: [
        {
          question: "Upload a screenshot?",
          header: "Screenshot",
          screenshotRequest: { prompt: "Upload screen" },
          options: [
            { label: "Yes", description: "Upload one" },
            { label: "No", description: "Do not upload" },
          ],
        },
      ],
    }),
  ).toBe(false);
});
