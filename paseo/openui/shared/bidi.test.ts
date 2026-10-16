import { describe, expect, it } from "vitest";

import { programIsRtl } from "./bidi.js";

describe("programIsRtl", () => {
  it("reads the strings, not the component names", () => {
    expect(programIsRtl('root = Stack([Heading("عرض توضيحي لنظام الإضافات"), Text("ok")])')).toBe(true);
  });

  it("is ltr for English programs", () => {
    expect(programIsRtl('root = Stack([Heading("Release status"), Text("ok")])')).toBe(false);
  });

  it("follows the majority in a mixed program", () => {
    expect(programIsRtl('root = Stack([Text("useEffect بيعمل re-render لما الـ deps تتغير")])')).toBe(true);
  });
});
