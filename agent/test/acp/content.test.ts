import type { ContentBlock } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import { convertV1PromptContent } from "../../src/acp/content.js";

describe("ACP prompt content", () => {
  test("preserves text, image, resource, and link order", () => {
    const image = Buffer.from("image").toString("base64");
    const content: ContentBlock[] = [
      { type: "text", text: "before" },
      { type: "image", data: image, mimeType: "image/png" },
      {
        type: "resource",
        resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "notes" },
      },
      {
        type: "resource",
        resource: { uri: "file:///diagram.png", mimeType: "image/png", blob: image },
      },
      { type: "resource_link", name: "source", uri: "file:///source.ts" },
      { type: "text", text: "after" },
    ];

    expect(convertV1PromptContent(content)).toEqual({
      text: [
        "before",
        "[Image: image/png]",
        '<resource uri="file:///notes.txt" mime="text/plain">\nnotes\n</resource>',
        "[Image resource: file:///diagram.png]",
        "[Resource: source] file:///source.ts",
        "after",
      ].join("\n"),
      images: [
        { type: "image", data: image, mimeType: "image/png" },
        { type: "image", data: image, mimeType: "image/png" },
      ],
    });
  });

  test("rejects malformed base64", () => {
    expect(() =>
      convertV1PromptContent([{ type: "image", data: "not base64!", mimeType: "image/png" }]),
    ).toThrow("invalid base64");
  });

  test("rejects unsupported image media", () => {
    expect(() =>
      convertV1PromptContent([
        { type: "image", data: Buffer.from("x").toString("base64"), mimeType: "text/plain" },
      ]),
    ).toThrow("unsupported image MIME type");
  });

  test("rejects oversized image blocks", () => {
    const data = Buffer.alloc(17).toString("base64");
    expect(() =>
      convertV1PromptContent([{ type: "image", data, mimeType: "image/png" }], 16),
    ).toThrow("exceeds 16 bytes");
  });

  test("rejects audio", () => {
    expect(() =>
      convertV1PromptContent([
        { type: "audio", data: Buffer.from("x").toString("base64"), mimeType: "audio/wav" },
      ]),
    ).toThrow("Unsupported ACP prompt content: audio");
  });
});
