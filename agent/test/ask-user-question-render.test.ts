import { expect, test } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import {
  renderAskUserQuestionCall,
  renderAskUserQuestionResult,
} from "../src/extensions/ask-user-question/render.js";
import { registerAskUserQuestionTool } from "../src/extensions/ask-user-question/ask-user-question.js";

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

test("ask user question uses RPC UI primitives", async () => {
  let registeredTool:
    | { executionMode?: string; execute: (...args: never[]) => Promise<unknown> }
    | undefined;
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const editorCalls: Array<{ title: string; prefill?: string }> = [];
  registerAskUserQuestionTool({
    on() {},
    registerTool(tool) {
      registeredTool = tool as never;
    },
    events: { emit() {} },
  } as never);

  expect(registeredTool?.executionMode).toBe("sequential");

  const result = await registeredTool!.execute(
    "question-call",
    {
      questions: [
        {
          question: "Pick path?",
          header: "Path",
          options: [
            { label: "Fast", description: "Ship quickly" },
            { label: "Safe", description: "Reduce risk" },
          ],
        },
        {
          question: "Pick checks?",
          header: "Checks",
          multiSelect: true,
          options: [
            { label: "Lint, format", description: "Run lint and format" },
            { label: "Tests", description: "Run tests" },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {
      cwd: "/tmp",
      hasUI: true,
      mode: "rpc",
      ui: {
        select: async (title: string, options: string[]) => {
          selectCalls.push({ title, options });
          return "Fast";
        },
        editor: async (title: string, prefill?: string) => {
          editorCalls.push({ title, prefill });
          return '["Lint, format","Tests"]';
        },
        custom: async () => {
          throw new Error("RPC path must not call custom UI");
        },
      },
    },
  );

  expect(selectCalls).toEqual([
    {
      title: "Pick path?",
      options: ["Fast", "Safe", "Type something.", "Chat about this"],
    },
  ]);
  expect(editorCalls[0]?.title).toContain("- Lint, format: Run lint and format");
  expect(result).toMatchObject({
    details: {
      cancelled: false,
      answers: [
        { questionIndex: 0, kind: "option", answer: "Fast" },
        { questionIndex: 1, kind: "multi", selected: ["Lint, format", "Tests"] },
      ],
    },
  });
});

test("ask user question preserves previews and custom multi-select text over RPC", async () => {
  let registeredTool: { execute: (...args: never[]) => Promise<unknown> } | undefined;
  const editorTitles: string[] = [];
  registerAskUserQuestionTool({
    on() {},
    registerTool(tool) {
      registeredTool = tool as never;
    },
    events: { emit() {} },
  } as never);

  const editorAnswers = ['["Alpha, beta","Custom choice"]', "Visual"];
  const result = await registeredTool!.execute(
    "question-call",
    {
      questions: [
        {
          question: "Pick areas?",
          header: "Areas",
          multiSelect: true,
          options: [
            { label: "Alpha, beta", description: "Comma label" },
            { label: "Gamma", description: "Another area" },
          ],
        },
        {
          question: "Pick layout?",
          header: "Layout",
          options: [
            { label: "Visual", description: "Visual layout", preview: "[ preview ]" },
            { label: "Plain", description: "Plain layout" },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {
      cwd: "/tmp",
      hasUI: true,
      mode: "rpc",
      ui: {
        editor: async (title: string) => {
          editorTitles.push(title);
          return editorAnswers.shift();
        },
        custom: async () => {
          throw new Error("RPC path must not call custom UI");
        },
      },
    },
  );

  expect(editorTitles[1]).toContain("[ preview ]");
  expect(result).toMatchObject({
    details: {
      cancelled: false,
      answers: [
        {
          kind: "multi",
          selected: ["Alpha, beta"],
          notes: "Custom choice",
        },
        { kind: "option", answer: "Visual", preview: "[ preview ]" },
      ],
    },
  });
});
