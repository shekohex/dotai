import { describe, expect, it } from "vitest";

import { formatSystemNote } from "./notice.js";
import {
  answerNote,
  askNote,
  isProgressToolName,
  reduceProgress,
  renderForAgent,
} from "./progress.js";
import {
  briefBody,
  noteChip,
  parseShow,
  progressCall,
  systemNoteBody,
} from "./timeline.js";

describe("steer notes in the timeline", () => {
  it("finds our notes and nothing else", () => {
    expect(systemNoteBody(formatSystemNote("Hello\nthere"))).toBe(
      "Hello\nthere",
    );
    expect(systemNoteBody("Please <paseo-system>x</paseo-system>")).toBeNull();
    expect(systemNoteBody("plain")).toBeNull();
  });

  it("labels answers, worker questions, and check-ins", () => {
    expect(noteChip(answerNote("Q3", "B", "keep it small")).label).toBe(
      "You answered Q3: B",
    );
    expect(
      noteChip(answerNote("Q3", "A,C", undefined, "The conductor")).label,
    ).toBe("The conductor answered Q3: A, C");
    expect(noteChip(answerNote("Q3", undefined, "use C")).label).toBe(
      "You answered Q3",
    );
    expect(
      noteChip(
        askNote({
          id: "Q7",
          title: "Colors",
          text: "Which?",
          options: [
            { key: "A", label: "Dark" },
            { key: "B", label: "Light" },
          ],
          askedAt: "",
          by: "w1",
        }),
      ).label,
    ).toBe("Worker asked Q7: Colors");
    expect(noteChip("Something else happened. More text.").label).toBe(
      "Something else happened. More text",
    );
  });
});

describe("progress tool calls in the timeline", () => {
  const item = (name: string, input: unknown, output: unknown = null) => ({
    name,
    status: "completed",
    error: null,
    detail: { type: "unknown", input, output },
  });

  it("matches the Claude and Codex names of our tool only", () => {
    expect(isProgressToolName("mcp__conductor__progress")).toBe(true);
    expect(isProgressToolName("conductor.progress")).toBe(true);
    expect(isProgressToolName("mcp__other__progress")).toBe(false);
    expect(
      progressCall(item("mcp__other__progress", { op: "show" })),
    ).toBeNull();
  });

  it("reads input and text output in either provider's shape", () => {
    expect(
      progressCall(
        item("mcp__conductor__progress", { op: "ticket", id: "T1" }, [
          { type: "text", text: "T01 working" },
        ]),
      ),
    ).toEqual({
      input: { op: "ticket", id: "T1" },
      status: "completed",
      output: "T01 working",
    });
    expect(
      progressCall({
        ...item("conductor.progress", '{"op":"show"}', {
          content: [{ type: "text", text: "x" }],
        }),
      })?.output,
    ).toBe("x");
    expect(
      progressCall({
        ...item("conductor.progress", { op: "finish" }),
        status: "failed",
        error: { message: "Cannot finish" },
      })?.error,
    ).toBe("Cannot finish");
  });

  it("reads back op=show", () => {
    const ts = "2026-10-16T00:00:00.000Z";
    const state = reduceProgress([
      { v: 1, ts, op: "start", title: "Ship" },
      { v: 1, ts, op: "ticket", id: "T01", title: "A", status: "done" },
      { v: 1, ts, op: "ticket", id: "T02", title: "B", status: "working" },
      { v: 1, ts, op: "ticker", text: "Building B" },
    ]);
    expect(parseShow(renderForAgent(state, Date.parse(ts)))).toMatchObject({
      title: "Ship",
      percent: 50,
      done: 1,
      total: 2,
      counts: { working: 1 },
      now: "Building B",
    });
    expect(
      parseShow(renderForAgent(state, Date.parse(ts), "AI"))?.counts.working,
    ).toBe(1);
    expect(parseShow("No progress run.")).toBeNull();
  });
});

describe("conductor briefs", () => {
  it("are found only when the whole message is wrapped", () => {
    expect(
      briefBody("<conductor-brief>\n## Task\nDo X\n</conductor-brief>"),
    ).toBe("## Task\nDo X");
    expect(briefBody("Hi <conductor-brief>x</conductor-brief>")).toBeNull();
  });
});
