import { describe, expect, it } from "vitest";

import { parseMarkdown, spans } from "./markdown.js";

describe("spans", () => {
  it("keeps inline marks as styles", () => {
    expect(
      spans("Use **bold**, _soft_, `code` and [docs](https://x.dev)."),
    ).toEqual([
      { text: "Use " },
      { text: "bold", bold: true },
      { text: ", " },
      { text: "soft", italic: true },
      { text: ", " },
      { text: "code", code: true },
      { text: " and " },
      { text: "docs", link: "https://x.dev" },
      { text: "." },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("parses the blocks a report uses", () => {
    const blocks = parseMarkdown(
      [
        "# Title",
        "",
        "First line",
        "continues here.",
        "",
        "- one",
        "  wrapped",
        "1. two",
        "- [x] done",
        "",
        "> quoted",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "---",
        "```",
        "raw **text**",
        "```",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "item",
      "item",
      "item",
      "quote",
      "table",
      "rule",
      "code",
    ]);
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      spans: [{ text: "First line continues here." }],
    });
    expect(blocks[2]).toMatchObject({
      marker: "•",
      spans: [{ text: "one" }, { text: " wrapped" }],
    });
    expect(blocks[4]).toMatchObject({ marker: "☑" });
    expect(blocks[6]).toMatchObject({
      rows: [
        [[{ text: "A" }], [{ text: "B" }]],
        [[{ text: "1" }], [{ text: "2" }]],
      ],
    });
    expect(blocks[8]).toEqual({ kind: "code", text: "raw **text**" });
  });
});
