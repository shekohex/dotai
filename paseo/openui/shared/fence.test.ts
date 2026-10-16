import { describe, expect, it } from "vitest";
import { hasFence, splitFences } from "./fence";

describe("splitFences", () => {
  it("splits prose around a closed block and reads the title", () => {
    const text = "Here it is:\n```openui Build status\nroot = Stack([Heading(\"Hi\")])\n```\nDone.";
    expect(splitFences(text)).toEqual([
      { kind: "text", text: "Here it is:" },
      { kind: "ui", ui: 'root = Stack([Heading("Hi")])', title: "Build status", complete: true },
      { kind: "text", text: "Done." },
    ]);
  });

  it("marks a block without a closing fence as streaming", () => {
    expect(splitFences("```openui\nroot = Stack([")).toEqual([
      { kind: "ui", ui: "root = Stack([", complete: false },
    ]);
  });

  it("leaves other fences as prose", () => {
    const text = "```ts\nconst a = 1\n```";
    expect(hasFence(text)).toBe(false);
    expect(splitFences(text)).toEqual([{ kind: "text", text }]);
  });

  it("handles two blocks", () => {
    const segments = splitFences("```openui\nroot = Stack([])\n```\n```openui\nroot = Stack([])\n```");
    expect(segments.map((segment) => segment.kind)).toEqual(["ui", "ui"]);
  });
});
