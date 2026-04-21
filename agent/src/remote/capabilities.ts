import type { ClientCapabilities } from "./schemas.js";

export const REMOTE_DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {
  protocolVersion: "1.0",
  primitives: {
    select: true,
    confirm: true,
    input: true,
    editor: true,
    custom: false,
    setWidget: true,
    setHeader: false,
    setFooter: false,
    setEditorComponent: false,
    onTerminalInput: false,
  },
};

export function cloneClientCapabilities(capabilities: ClientCapabilities): ClientCapabilities {
  return {
    protocolVersion: capabilities.protocolVersion,
    primitives: {
      ...capabilities.primitives,
    },
  };
}

export function mergeClientCapabilities(
  capabilitiesList: Iterable<ClientCapabilities | undefined>,
): ClientCapabilities {
  const merged: ClientCapabilities = {
    protocolVersion: REMOTE_DEFAULT_CLIENT_CAPABILITIES.protocolVersion,
    primitives: {
      select: false,
      confirm: false,
      input: false,
      editor: false,
      custom: false,
      setWidget: false,
      setHeader: false,
      setFooter: false,
      setEditorComponent: false,
      onTerminalInput: false,
    },
  };

  for (const capabilities of capabilitiesList) {
    if (!capabilities) {
      continue;
    }
    merged.primitives.select ||= capabilities.primitives.select;
    merged.primitives.confirm ||= capabilities.primitives.confirm;
    merged.primitives.input ||= capabilities.primitives.input;
    merged.primitives.editor ||= capabilities.primitives.editor;
    merged.primitives.custom ||= capabilities.primitives.custom;
    merged.primitives.setWidget ||= capabilities.primitives.setWidget;
    merged.primitives.setHeader ||= capabilities.primitives.setHeader;
    merged.primitives.setFooter ||= capabilities.primitives.setFooter;
    merged.primitives.setEditorComponent ||= capabilities.primitives.setEditorComponent;
    merged.primitives.onTerminalInput ||= capabilities.primitives.onTerminalInput;
  }
  return merged;
}
