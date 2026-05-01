export function buildRemoteAuthHeaders(input: {
  token: string | undefined;
  connectionId: string | undefined;
}): Record<string, string> {
  if (input.token === undefined || input.token.length === 0) {
    throw new Error("Remote auth token is missing");
  }

  return {
    authorization: `Bearer ${input.token}`,
    ...(input.connectionId !== undefined && input.connectionId.length > 0
      ? { "x-pi-connection-id": input.connectionId }
      : {}),
  };
}

export function readRemoteConnectionIdHeader(response: Response): string | undefined {
  const header = response.headers.get("x-pi-connection-id");
  if (header === null || header.length === 0) {
    return undefined;
  }
  return header;
}

export function resolveRemoteConnectionId(input: {
  connectionId: string | undefined;
  token: string | undefined;
}): string {
  if (input.connectionId !== undefined && input.connectionId.length > 0) {
    return input.connectionId;
  }
  if (input.token !== undefined && input.token.length > 0) {
    return input.token;
  }
  throw new Error("Remote connection id is missing");
}
