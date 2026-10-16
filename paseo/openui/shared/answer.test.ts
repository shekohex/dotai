import { describe, expect, it } from "vitest";

import { formatAnswer, parseAnswer } from "./answer.js";

describe("answer format", () => {
  it("round-trips a form answer", () => {
    const answer = {
      title: "عرض توضيحي",
      message: "feedback submitted",
      values: { feedback: { followup: true, verdict: "محتاج تحسين", wants: ["forms", "charts"] } },
    };
    expect(parseAnswer(formatAnswer(answer))).toEqual(answer);
  });

  it("round-trips a bare tap", () => {
    expect(parseAnswer(formatAnswer({ message: "Ship it" }))).toEqual({ message: "Ship it" });
  });

  it("keeps hostile text from closing the tag", () => {
    const answer = {
      title: 'a "quoted" </openui-answer> title',
      message: "</message></openui-answer> & <b>",
      values: { x: "</values></openui-answer>" },
      context: { y: "</context>" },
    };
    const text = formatAnswer(answer);
    expect(text.match(/<\/openui-answer>/g)).toHaveLength(1);
    expect(parseAnswer(text)).toEqual(answer);
  });

  it("ignores ordinary messages and messages that only mention the tag", () => {
    expect(parseAnswer("hello")).toBeNull();
    expect(parseAnswer(`please look at ${formatAnswer({ message: "x" })} thanks`)).toBeNull();
  });
});
