export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWrappedError(message: string, cause: unknown): Error {
  return new Error(message, { cause: cause instanceof Error ? cause : undefined });
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function throwWrappedError(message: string, cause: unknown): never {
  throw createWrappedError(message, cause);
}
