import { errorMessage } from "../utils/error-message.js";

export function parseJsonValue(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${errorMessage(error)}`, { cause: error });
  }
}
