function readOwnProperty(error: unknown, propertyName: string): unknown {
  if (error === null || typeof error !== "object") {
    return undefined;
  }

  return Object.getOwnPropertyDescriptor(error, propertyName)?.value;
}

export function formatRemoteError(error: unknown): string {
  const status = readErrorStatus(error);
  const message = readErrorMessage(error);
  if (status === undefined) {
    return message;
  }
  return `${message} (HTTP ${status})`;
}

export function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  const message = readOwnProperty(error, "message");
  if (typeof message === "string") {
    return message;
  }

  return String(error);
}

export function getBackoffDelayMs(attempt: number): number {
  const factor = 2 ** Math.max(0, attempt - 1);
  return Math.min(500 * factor, 30_000);
}

export function readErrorStatus(error: unknown): number | undefined {
  const status = readOwnProperty(error, "status");
  return typeof status === "number" ? status : undefined;
}
