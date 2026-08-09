import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationSchema,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { formatAcpNotification, type AcpUi } from "../ui.js";
import { isRecord } from "../../utils/unknown-data.js";

interface ElicitationClient {
  request(
    method: "elicitation/create",
    request: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse>;
  notify?(method: "session/update", notification: SessionNotification): Promise<void>;
}

export function createAcpV1Ui(
  client: ElicitationClient,
  sessionId: string,
  supported: boolean,
): AcpUi {
  let notificationId = 0;
  const elicit = (
    message: string,
    property: ElicitationSchema,
  ): Promise<CreateElicitationResponse> => {
    if (!supported) throw new Error("ACP client does not support elicitation");
    return client.request("elicitation/create", {
      mode: "form",
      sessionId,
      message,
      requestedSchema: property,
    });
  };
  return {
    async select(title, options) {
      const response = await elicit(title, {
        type: "object",
        properties: { value: { type: "string", enum: options } },
        required: ["value"],
      });
      return acceptedString(response);
    },
    async confirm(title, message) {
      const response = await elicit(`${title}: ${message}`, {
        type: "object",
        properties: { value: { type: "boolean" } },
        required: ["value"],
      });
      return acceptedBoolean(response) ?? false;
    },
    async input(title, placeholder) {
      const response = await elicit(title, {
        type: "object",
        properties: {
          value: { type: "string", description: placeholder },
        },
        required: ["value"],
      });
      return acceptedString(response);
    },
    async editor(title, prefill) {
      const response = await elicit(title, {
        type: "object",
        properties: { value: { type: "string", default: prefill } },
        required: ["value"],
      });
      return acceptedString(response);
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
