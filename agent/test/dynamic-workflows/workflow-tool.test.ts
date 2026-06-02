import assert from "node:assert/strict";
import { test } from "vitest";
import { backgroundStartedText } from "../../src/extensions/dynamic-workflows/workflow-tool.js";

test("backgroundStartedText tells the user it auto-continues and they can wait", () => {
  const text = backgroundStartedText("audit", "abc-123");
  assert.match(text, /audit/);
  assert.match(text, /abc-123/);
  // The key reassurance the user asked for.
  assert.match(text, /wait here/i);
  assert.match(text, /continues automatically|resume the conversation/i);
  // Still offers the non-blocking "go do other things" path and tracking.
  assert.match(text, /other things/i);
  assert.match(text, /\/workflows status abc-123/);
});
