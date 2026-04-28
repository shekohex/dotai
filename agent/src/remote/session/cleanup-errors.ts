import { errorMessage } from "../../utils/error-message.js";

export function formatEphemeralCleanupError(error: unknown): string {
  const message = errorMessage(error);
  return message.length > 0
    ? `Failed to clean up ephemeral session: ${message}`
    : "Failed to clean up ephemeral session.";
}
