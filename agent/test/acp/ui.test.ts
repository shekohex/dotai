import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import { createAcpV1Ui } from "../../src/acp/v1/ui.js";

describe("ACP v1 extension UI", () => {
  test("maps select, confirm, input, and editor to elicitation forms", async () => {
    const requests: CreateElicitationRequest[] = [];
    const responses: CreateElicitationResponse[] = [
      { action: "accept", content: { value: "second" } },
      { action: "accept", content: { value: true } },
      { action: "accept", content: { value: "input" } },
      { action: "accept", content: { value: "edited" } },
    ];
    const notifications: SessionNotification[] = [];
    const ui = createAcpV1Ui(
      {
        request: (_method, request) => {
          requests.push(request);
          return Promise.resolve(responses.shift()!);
        },
        notify: (_method, notification) => {
          notifications.push(notification);
          return Promise.resolve();
        },
      },
      "session-1",
      true,
    );

    await expect(ui.select("Choose", ["first", "second"])).resolves.toBe("second");
    await expect(ui.confirm("Confirm", "Continue?")).resolves.toBe(true);
    await expect(ui.input("Input", "placeholder")).resolves.toBe("input");
    await expect(ui.editor("Editor", "prefill")).resolves.toBe("edited");
    ui.notify("Mode changed", "warning");

    expect(requests).toHaveLength(4);
    expect(requests[0]).toMatchObject({
      mode: "form",
      sessionId: "session-1",
      message: "Choose",
      requestedSchema: {
        properties: { value: { type: "string", enum: ["first", "second"] } },
      },
    });
    expect(requests[1]).toMatchObject({
      requestedSchema: { properties: { value: { type: "boolean" } } },
    });
    expect(notifications).toEqual([
      {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "session-1:ui:1",
          content: {
            type: "text",
            text: "\n\n> **Warning**\n>\n> Mode changed\n\n",
          },
        },
      },
    ]);
  });

  test("maps cancelled elicitation to command cancellation", async () => {
    const ui = createAcpV1Ui(
      { request: () => Promise.resolve({ action: "cancel" }) },
      "session-1",
      true,
    );
    await expect(ui.select("Choose", ["first"])).resolves.toBeUndefined();
    await expect(ui.confirm("Confirm", "Continue?")).resolves.toBe(false);
    await expect(ui.input("Input")).resolves.toBeUndefined();
    await expect(ui.editor("Editor")).resolves.toBeUndefined();
  });

  test("fails explicitly when client has no elicitation support", async () => {
    const ui = createAcpV1Ui(
      { request: () => Promise.resolve({ action: "cancel" }) },
      "session-1",
      false,
    );
    await expect(ui.select("Choose", ["first"])).rejects.toThrow(
      "ACP client does not support elicitation",
    );
  });
});
