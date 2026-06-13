import { expect, test } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import {
  renderAskUserQuestionCall,
  renderAskUserQuestionResult,
} from "../src/extensions/ask-user-question/render.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
  italic: (value: string) => value,
};

const callArgs = {
  questions: [
    {
      question: "Pick path?",
      header: "Path",
      options: [
        { label: "Fast", description: "Ship quickly" },
        { label: "Safe", description: "Reduce risk" },
      ],
    },
  ],
};

test("ask user question result updates original call row", () => {
  const state = {};
  const call = renderAskUserQuestionCall(callArgs, theme as never, {
    isError: false,
    isPartial: true,
    lastComponent: undefined,
    state,
  });

  expect(call.render(120).join("\n")).toContain("? asking 1 question");

  const result = renderAskUserQuestionResult(
    {
      content: [{ type: "text", text: "User has answered your questions" }],
      details: {
        cancelled: false,
        answers: [{ questionIndex: 0, question: "Pick path?", kind: "option", answer: "Fast" }],
      },
    } as never,
    { expanded: false, isPartial: false } as never,
    theme as never,
    { isError: false, isPartial: false, lastComponent: new Text("", 0, 0), args: callArgs, state },
  );

  expect(call.render(120).join("\n")).toContain("? asked 1 question · 1/1 answered");
  expect(result.render(120).join("\n")).toBe("");
});

test("ask user question errors render as failed, not cancelled", () => {
  const state = {};
  const call = renderAskUserQuestionCall(callArgs, theme as never, {
    isError: false,
    isPartial: true,
    lastComponent: undefined,
    state,
  });

  renderAskUserQuestionResult(
    {
      content: [{ type: "text", text: "Error: invalid question" }],
      details: { cancelled: true, answers: [], error: "invalid_screenshot_request" },
    } as never,
    { expanded: false, isPartial: false } as never,
    theme as never,
    { isError: true, isPartial: false, lastComponent: new Text("", 0, 0), args: callArgs, state },
  );

  expect(call.render(120).join("\n")).toContain("? failed 1 question · 0/1 answered");
});
