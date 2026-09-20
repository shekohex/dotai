import type { PaseoApi } from "@getpaseo/client";

import type {
  CubeAgentCompletionNotification,
  CubeAgentCompletionNotifier,
} from "./work-service.js";

export class PaseoCompletionNotifier implements CubeAgentCompletionNotifier {
  private paseo: PaseoApi | undefined;

  setPaseo(paseo: PaseoApi): void {
    this.paseo = paseo;
  }

  async notify(notification: CubeAgentCompletionNotification): Promise<void> {
    if (!this.paseo) {
      throw new Error(
        "Local Paseo API is unavailable for CubeSandbox callback",
      );
    }
    const payload = {
      type: "cubesandbox.agent_completion",
      workId: notification.workId,
      agentId: notification.agentId,
      status: notification.status,
      ...(notification.lastAssistantMessage
        ? { lastAssistantMessage: notification.lastAssistantMessage }
        : {}),
    };
    const sendOptions = {
      messageId: notification.notificationId,
      activeTurnBehavior: "steer" as const,
    };
    await this.paseo.agents
      .ref(notification.coordinatorAgentId)
      .send(
        `CubeSandbox completion notification\n${JSON.stringify(payload)}`,
        sendOptions,
      );
  }
}
