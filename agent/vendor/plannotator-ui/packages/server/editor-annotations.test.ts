import { describe, expect, test } from "bun:test";
import { createEditorAnnotationHandler } from "./editor-annotations";

describe("editor annotations SSE", () => {
  test("serves SSE stream endpoint with snapshot", async () => {
    const handler = createEditorAnnotationHandler();

    const res = await handler.handle(
      new Request("http://localhost/api/editor-annotations/stream"),
      new URL("http://localhost/api/editor-annotations/stream"),
    );

    expect(res).not.toBeNull();
    expect(res?.headers.get("content-type")).toBe("text/event-stream");

    const reader = res?.body?.getReader();
    const chunk = reader ? await reader.read() : null;
    await reader?.cancel();
    const text = chunk?.value ? new TextDecoder().decode(chunk.value) : "";
    expect(text).toContain('"type":"snapshot"');
  });
});
