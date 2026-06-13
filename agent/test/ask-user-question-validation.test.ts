import { expect, test } from "vitest";
import { buildItemsForQuestion } from "../src/extensions/ask-user-question/ask-user-question.js";
import { validateQuestionnaire } from "../src/extensions/ask-user-question/tool/validate-questionnaire.js";

test("screenshot request questions render as free-text only", () => {
  const question = {
    question: "Upload a screenshot of the broken screen?",
    header: "Screenshot",
    options: [],
    screenshotRequest: { prompt: "Upload the broken screen" },
  };

  expect(validateQuestionnaire({ questions: [question] })).toEqual({ ok: true });
  expect(buildItemsForQuestion(question).map((item) => item.kind)).toEqual(["other"]);
});

test("screenshot request questions reject authored options", () => {
  expect(
    validateQuestionnaire({
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
  ).toMatchObject({
    ok: false,
    error: "invalid_screenshot_request",
    message: expect.stringContaining("Do not combine screenshotRequest with choice options"),
  });
});
