import { cloneClientCapabilities, mergeClientCapabilities } from "../capabilities.js";
import type { ClientCapabilities, Presence } from "../schemas.js";

export function getSessionRuntimeCapabilities(presence: Map<string, Presence>): ClientCapabilities {
  return normalizeRemoteServerRuntimeCapabilities(
    mergeClientCapabilities(readPresenceCapabilities(presence)),
  );
}

export function hasSessionPrimitiveCapability(
  presence: Map<string, Presence>,
  primitive: keyof ClientCapabilities["primitives"],
): boolean {
  return getSessionRuntimeCapabilities(presence).primitives[primitive];
}

function* readPresenceCapabilities(
  presence: Map<string, Presence>,
): Iterable<ClientCapabilities | undefined> {
  for (const item of presence.values()) {
    yield item.clientCapabilities ? cloneClientCapabilities(item.clientCapabilities) : undefined;
  }
}

function normalizeRemoteServerRuntimeCapabilities(
  capabilities: ClientCapabilities,
): ClientCapabilities {
  return {
    ...capabilities,
    primitives: {
      ...capabilities.primitives,
      custom: false,
      setHeader: false,
      setFooter: false,
      setEditorComponent: false,
      onTerminalInput: false,
    },
  };
}
