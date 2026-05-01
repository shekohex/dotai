import { isRecord } from "../../utils/unknown-data.js";

export function readObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export class RemoteApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RemoteApiError";
    this.status = status;
  }
}

export function createRemoteApiError(status: number, message: string): RemoteApiError {
  return new RemoteApiError(status, message);
}

export async function toRemoteHttpError(response: Response): Promise<RemoteApiError> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return createRemoteApiError(response.status, response.statusText || `HTTP ${response.status}`);
  }
  try {
    const body: unknown = await response.json();
    const bodyObject = readObject(body);
    const errorValue = bodyObject?.error;
    const detailsValue = bodyObject?.details;
    const errorMessage = typeof errorValue === "string" ? errorValue : undefined;
    const detailsMessage = typeof detailsValue === "string" ? detailsValue : undefined;
    const message =
      errorMessage !== undefined && detailsMessage !== undefined
        ? `${errorMessage}: ${detailsMessage}`
        : (errorMessage ?? response.statusText);
    return createRemoteApiError(response.status, message);
  } catch {
    return createRemoteApiError(response.status, response.statusText || `HTTP ${response.status}`);
  }
}
