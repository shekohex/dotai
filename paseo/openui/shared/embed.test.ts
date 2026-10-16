import { describe, expect, it } from "vitest";
import { embedHeight, embedSource } from "./embed";

describe("embedSource", () => {
  it("turns video links into players", () => {
    expect(embedSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ kind: "url", url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" });
    expect(embedSource("https://youtu.be/dQw4w9WgXcQ?t=3")).toEqual({ kind: "url", url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" });
    expect(embedSource("https://vimeo.com/123456")).toEqual({ kind: "url", url: "https://player.vimeo.com/video/123456" });
  });
  it("keeps https pages and local http, treats bare text as a file", () => {
    expect(embedSource("https://example.com/a?b=1")).toEqual({ kind: "url", url: "https://example.com/a?b=1" });
    expect(embedSource("http://localhost:3000/x").kind).toBe("url");
    expect(embedSource("docs/report.html")).toEqual({ kind: "file", path: "docs/report.html" });
  });
  it("refuses other schemes", () => {
    expect(embedSource("javascript:alert(1)").kind).toBe("invalid");
    expect(embedSource("http://example.com").kind).toBe("invalid");
    expect(embedSource("file:///etc/passwd").kind).toBe("invalid");
    expect(embedSource("").kind).toBe("invalid");
  });
  it("clamps height", () => {
    expect(embedHeight(undefined)).toBe(320);
    expect(embedHeight(5000)).toBe(900);
    expect(embedHeight(10)).toBe(120);
  });
});

import { htmlDocument } from "./embed";

describe("htmlDocument", () => {
  it("wraps snippets and keeps full pages", () => {
    expect(htmlDocument("<p>x</p>")).toMatch(/^<!doctype html><meta charset="utf-8">.*<p>x<\/p>$/);
    expect(htmlDocument("<!DOCTYPE html><html><body>x</body></html>")).toBe("<!DOCTYPE html><html><body>x</body></html>");
    expect(htmlDocument("<html><body>x</body></html>")).toBe("<html><body>x</body></html>");
  });
});
