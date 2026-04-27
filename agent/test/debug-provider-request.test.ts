import { describe, expect, it } from "vitest";
import { buildProviderRequestRecord } from "../src/extensions/debug-provider-request.js";

describe("debug provider request logging", () => {
  it("extracts request system prompt from openai responses developer message", () => {
    const turnSystemPrompt = "Base prompt";
    const payload = {
      model: "gpt-5.5",
      input: [
        {
          role: "developer",
          content: "Base prompt\n\nExecutor instructions",
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };

    const record = buildProviderRequestRecord({
      payload,
      turnSystemPrompt,
      ctx: {
        cwd: "/tmp/project",
        model: { provider: "openai", id: "gpt-5.5" },
        getSystemPrompt: () => "fallback prompt",
        sessionManager: {
          getSessionId: () => "session-id",
          getSessionFile: () => "/tmp/session.jsonl",
        },
      } as never,
    });

    expect(record.requestSystemPrompt).toBe("Base prompt\n\nExecutor instructions");
    expect(record.effectiveSystemPrompt).toBe(record.requestSystemPrompt);
  });
});
