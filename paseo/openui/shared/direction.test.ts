import { describe, expect, it } from "vitest";

import { detectDirection } from "./direction.js";

describe("detectDirection", () => {
  it("is rtl when Arabic comes first", () => {
    expect(
      detectDirection("الـ useEffect بيعمل re-render لما الـ deps تتغير"),
    ).toBe("rtl");
  });

  it("is rtl when Latin comes first but Arabic words are the majority", () => {
    expect(
      detectDirection("useEffect بيعمل re-render لما الـ deps تتغير"),
    ).toBe("rtl");
  });

  it("is ltr for English", () => {
    expect(detectDirection("Run npm install then restart")).toBe("ltr");
  });

  it("ignores inline code when finding the first strong character", () => {
    expect(detectDirection("`src/hooks/useAuth.ts` ده الملف")).toBe("rtl");
  });

  it("ignores fenced code", () => {
    expect(detectDirection("```ts\nconst a = 1;\n```\nده الملف")).toBe("rtl");
  });

  it("is ltr when Latin comes first and Latin words are the majority", () => {
    expect(detectDirection("Run the build ثم اختبر")).toBe("ltr");
  });

  it("is ltr on a tie when Latin comes first", () => {
    expect(detectDirection("deploy الآن")).toBe("ltr");
  });

  it("is ltr for empty and punctuation-only text", () => {
    expect(detectDirection("")).toBe("ltr");
    expect(detectDirection("   ")).toBe("ltr");
    expect(detectDirection("... !? 123 ،؟")).toBe("ltr");
  });

  it("does not treat Arabic punctuation or digits as strong Arabic", () => {
    expect(detectDirection("،٣ hello world")).toBe("ltr");
  });

  it("counts a token mixing Arabic and Latin as Arabic", () => {
    expect(detectDirection("check الـdeps الـcleanup")).toBe("rtl");
  });
});
