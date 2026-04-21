import { cloneClientCapabilities } from "../capabilities.js";
import type { ClientCapabilities, ConnectionCapabilitiesResponse } from "../schemas.js";
import type { SessionRecord } from "./types.js";

type ConnectionCapabilitiesRecord = {
  clientId: string;
  keyId: string;
  capabilities: ClientCapabilities;
  updatedAt: number;
};

function createConnectionCapabilitiesKey(clientId: string, connectionId: string): string {
  return `${clientId}\u0000${connectionId}`;
}

export function setConnectionCapabilitiesForSessions(input: {
  connectionCapabilities: Map<string, ConnectionCapabilitiesRecord>;
  sessions: Map<string, SessionRecord>;
  connectionId: string;
  capabilities: ClientCapabilities;
  client: { clientId: string; keyId: string };
  now: () => number;
}): ConnectionCapabilitiesResponse {
  const updatedAt = input.now();
  const clonedCapabilities = cloneClientCapabilities(input.capabilities);
  const recordKey = createConnectionCapabilitiesKey(input.client.clientId, input.connectionId);
  input.connectionCapabilities.set(recordKey, {
    clientId: input.client.clientId,
    keyId: input.client.keyId,
    capabilities: clonedCapabilities,
    updatedAt,
  });

  for (const record of input.sessions.values()) {
    const presence = record.presence.get(input.connectionId);
    if (!presence || presence.clientId !== input.client.clientId) {
      continue;
    }
    presence.clientCapabilities = cloneClientCapabilities(clonedCapabilities);
    presence.lastSeenAt = updatedAt;
  }

  return {
    connectionId: input.connectionId,
    updatedAt,
  };
}

export function readConnectionCapabilitiesForSessions(
  connectionCapabilities: Map<string, ConnectionCapabilitiesRecord>,
  clientId: string,
  connectionId: string,
): ClientCapabilities | undefined {
  const entry = connectionCapabilities.get(createConnectionCapabilitiesKey(clientId, connectionId));
  if (!entry) {
    return undefined;
  }

  return cloneClientCapabilities(entry.capabilities);
}
