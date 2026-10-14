import { expect, test } from "vitest";
import { calls, createTestSession, says, when } from "@support/pi-test-harness";
import askUserQuestionExtension from "../src/extensions/ask-user-question/index.js";
import { createMockUIContext } from "./support/pi-test-harness/mock-ui.js";

test("RPC questionnaire consumes client form answers without extra editor dialogs", async () => {
  const session = await createTestSession({ extensionFactories: [askUserQuestionExtension] });
  const selectAnswers = ["Type something.", "Visual", "Fast"];
  // Paseo maps form multi-select answers to one-based indices and custom answers to select + input.
  const inputAnswers = ["Nebula", "1,2"];
  const ui = createMockUIContext(
    {
      select: () => selectAnswers.shift(),
      input: () => inputAnswers.shift(),
      editor: () => {
        throw new Error("Unexpected extra editor dialog after client questionnaire");
      },
    },
    session.events.ui,
  );
  try {
    await session.session.bindExtensions({ mode: "rpc", uiContext: ui });
    await session.run(
      when("Ask for preferences", [
        calls("ask_user_question", {
          questions: [
            {
              question: "What project name?",
              header: "Project",
              options: [
                { label: "Atlas", description: "Map theme" },
                { label: "Beacon", description: "Light theme" },
              ],
            },
            {
              question: "Which checks?",
              header: "Checks",
              multiSelect: true,
              options: [
                { label: "Lint", description: "Check style" },
                { label: "Tests", description: "Check behavior" },
              ],
            },
            {
              question: "Which layout?",
              header: "Layout",
              options: [
                { label: "Visual", description: "Diagram", preview: "[ preview ]" },
                { label: "Plain", description: "Text" },
              ],
            },
            {
              question: "Which path?",
              header: "Path",
              options: [
                { label: "Fast", description: "Ship quickly" },
                { label: "Safe", description: "Reduce risk" },
              ],
            },
          ],
        }),
        says("Preferences received"),
      ]),
    );
    expect(session.events.toolResults[0]).toMatchObject({
      isError: false,
      details: {
        cancelled: false,
        answers: [
          { questionIndex: 0, kind: "custom", answer: "Nebula" },
          { questionIndex: 1, kind: "multi", selected: ["Lint", "Tests"] },
          { questionIndex: 2, kind: "option", answer: "Visual", preview: "[ preview ]" },
          { questionIndex: 3, kind: "option", answer: "Fast" },
        ],
      },
    });
    expect(session.events.ui.map((call) => call.method)).toEqual([
      "select",
      "input",
      "input",
      "select",
      "select",
    ]);
    expect(selectAnswers).toEqual([]);
    expect(inputAnswers).toEqual([]);
  } finally {
    session.dispose();
  }
});

test.each(["select", "custom", "multi"])(
  "RPC %s cancellation preserves earlier answers and stops questionnaire",
  async (cancelAt) => {
    const session = await createTestSession({ extensionFactories: [askUserQuestionExtension] });
    let selectCount = 0;
    const ui = createMockUIContext(
      {
        select: () => {
          selectCount += 1;
          if (selectCount === 1) return "Fast";
          return cancelAt === "custom" ? "Type something." : undefined;
        },
        input: () => undefined,
      },
      session.events.ui,
    );
    const options = [
      { label: "Fast", description: "Ship quickly" },
      { label: "Safe", description: "Reduce risk" },
    ];
    try {
      await session.session.bindExtensions({ mode: "rpc", uiContext: ui });
      await session.run(
        when("Ask for preferences", [
          calls("ask_user_question", {
            questions: [
              { question: "First?", header: "First", options },
              {
                question: "Second?",
                header: "Second",
                options,
                multiSelect: cancelAt === "multi",
              },
              { question: "Third?", header: "Third", options },
            ],
          }),
          says("Cancelled"),
        ]),
      );
      expect(session.events.toolResults[0]).toMatchObject({
        isError: false,
        details: {
          cancelled: true,
          answers: [{ questionIndex: 0, kind: "option", answer: "Fast" }],
        },
      });
      expect(session.events.ui.map((call) => call.method)).toEqual(
        cancelAt === "multi"
          ? ["select", "input"]
          : cancelAt === "custom"
            ? ["select", "select", "input"]
            : ["select", "select"],
      );
    } finally {
      session.dispose();
    }
  },
);
