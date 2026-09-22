import { expect, test } from "vitest";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SubagentRuntimeEventBus } from "../src/subagent-sdk/events.js";
import { forwardLiteChildEvent } from "../src/subagent-sdk/lite-events.js";

test("lite child turn_end event is forwarded unchanged", () => {
  const event = {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
    toolResults: [],
  } satisfies Extract<AgentSessionEvent, { type: "turn_end" }>;
  const eventBus = new SubagentRuntimeEventBus();
  let received: unknown;
  eventBus.subscribeChildEvent((childEvent) => {
    received = childEvent;
  });

  forwardLiteChildEvent(eventBus, "child-session", event);

  expect(received).toBe(event);
});
