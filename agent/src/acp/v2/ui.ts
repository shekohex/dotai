import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationSchema,
  UpdateSessionNotification,
} from "@agentclientprotocol/sdk/experimental/v2";
import { formatAcpNotification, type AcpUi } from "../ui.js";
import { isRecord } from "../../utils/unknown-data.js";

interface ElicitationClient {
  request(
    method: "elicitation/create",
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse>;
  notify?(method: "session/update", notification: UpdateSessionNotification): Promise<void>;
}

export function createAcpV2Ui(
  client: ElicitationClient,
  sessionId: string,
  supported: boolean,
  setWaiting: (waiting: boolean) => Promise<void>,
): AcpUi {
  let notificationId = 0;
  const elicit = async (
    message: string,
    requestedSchema: ElicitationSchema,
  ): Promise<CreateElicitationResponse> => {
    if (!supported) throw new Error("ACP client does not support elicitation");
    await setWaiting(true);
    try {
      return await client.request("elicitation/create", {
        mode: "form",
        sessionId,
        message,
        requestedSchema,
      });
    } finally {
      await setWaiting(false);
    }
  };
  return {
    async select(title, options) {
      return acceptedString(
        await elicit(title, {
          type: "object",
          properties: { value: { type: "string", enum: options } },
          required: ["value"],
        }),
      );
    },
    async confirm(title, message) {
      return (
        acceptedBoolean(
          await elicit(`${title}: ${message}`, {
            type: "object",
            properties: { value: { type: "boolean" } },
            required: ["value"],
          }),
        ) ?? false
      );
    },
    async input(title, placeholder) {
      return acceptedString(
        await elicit(title, {
          type: "object",
          properties: { value: { type: "string", description: placeholder } },
          required: ["value"],
        }),
      );
    },
    async editor(title, prefill) {
      return acceptedString(
        await elicit(title, {
          type: "object",
          properties: { value: { type: "string", default: prefill } },
          required: ["value"],
        }),
      );
    },
    notify(message, level) {
      notificationId += 1;
      void client
        .notify?.("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: `${sessionId}:ui:${notificationId}`,
            content: { type: "text", text: formatAcpNotification(message, level) },
          },
        })
        .catch(() => {});
    },
  };
}

function acceptedString(response: CreateElicitationResponse): string | undefined {
  const value = acceptedContent(response)?.value;
  return typeof value === "string" ? value : undefined;
}

function acceptedBoolean(response: CreateElicitationResponse): boolean | undefined {
  const value = acceptedContent(response)?.value;
  return typeof value === "boolean" ? value : undefined;
}

function acceptedContent(response: CreateElicitationResponse): Record<string, unknown> | undefined {
  if (response.action !== "accept" || !("content" in response)) return undefined;
  return isRecord(response.content) ? response.content : undefined;
}
