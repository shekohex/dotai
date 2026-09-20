import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it, vi } from "vitest";

import { PaseoCompletionNotifier } from "./completion-notifier.js";

describe("PaseoCompletionNotifier", () => {
  it("sends a deduplicated callback payload to the initiating agent", async () => {
    const send = vi.fn(async () => undefined);
    const ref = vi.fn(() => ({ send }));
    const notifier = new PaseoCompletionNotifier();
    notifier.setPaseo({ agents: { ref } } as unknown as PaseoApi);

    await notifier.notify({
      notificationId: "cubesandbox:work-1:agent-1:1",
      coordinatorAgentId: "coordinator-1",
      workId: "work-1",
      agentId: "agent-1",
      status: "idle",
      lastAssistantMessage: "Done.",
    });

    expect(ref).toHaveBeenCalledWith("coordinator-1");
    expect(send).toHaveBeenCalledWith(
      'CubeSandbox completion notification\n{"type":"cubesandbox.agent_completion","workId":"work-1","agentId":"agent-1","status":"idle","lastAssistantMessage":"Done."}',
      {
        messageId: "cubesandbox:work-1:agent-1:1",
        activeTurnBehavior: "steer",
      },
    );
  });
});
