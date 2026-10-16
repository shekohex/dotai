import { describe, expect, it } from "vitest";
import { checkUi, guideText } from "./guide";

describe("guides", () => {
  it("tool guide also offers the fence", () => {
    const guide = guideText("tool");
    expect(guide).toContain("call the render tool");
    expect(guide).toContain("```openui fence");
  });

  it("fence guide has no render tool instructions", () => {
    const guide = guideText("fence");
    expect(guide).toContain("```openui fence");
    expect(guide).not.toContain("call the render tool");
    expect(guide).not.toContain("wait=true");
  });

  it("checks a program", () => {
    expect(checkUi('root = Stack([Heading("Hi")])').errors).toEqual([]);
  });
});
