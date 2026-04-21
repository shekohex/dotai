import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { RemoteKvReadResponse, RemoteKvScope, RemoteKvWriteResponse } from "../../schemas.js";

export type ExtensionStateKvClient = {
  readKv(scope: RemoteKvScope, namespace: string, key: string): Promise<RemoteKvReadResponse>;
  writeKv(
    scope: RemoteKvScope,
    namespace: string,
    key: string,
    value: unknown,
  ): Promise<RemoteKvWriteResponse>;
};

type ExtensionStateBinding = {
  customType: string;
  scope: "global" | "user";
  namespace: string;
  key: string;
};

const extensionStateBindings: ReadonlyArray<ExtensionStateBinding> = [
  {
    customType: "openusage-state",
    scope: "user",
    namespace: "openusage",
    key: "state",
  },
];

function findExtensionStateBinding(customType: string): ExtensionStateBinding | undefined {
  return extensionStateBindings.find((binding) => binding.customType === customType);
}

function formatBindingLabel(binding: ExtensionStateBinding): string {
  return `${binding.scope}/${binding.namespace}/${binding.key}`;
}

export async function hydrateExtensionStateFromKv(input: {
  client: ExtensionStateKvClient;
  sessionManager: SessionManager;
}): Promise<void> {
  for (const binding of extensionStateBindings) {
    const result = await input.client.readKv(binding.scope, binding.namespace, binding.key);
    if (!result.found) {
      continue;
    }
    input.sessionManager.appendCustomEntry(binding.customType, result.value);
  }
}

export function isKvManagedExtensionState(customType: string): boolean {
  return findExtensionStateBinding(customType) !== undefined;
}

export async function persistExtensionStateToKv(input: {
  client: ExtensionStateKvClient;
  customType: string;
  value: unknown;
}): Promise<void> {
  const binding = findExtensionStateBinding(input.customType);
  if (!binding) {
    return;
  }
  await input.client.writeKv(binding.scope, binding.namespace, binding.key, input.value);
}

export async function persistManagedExtensionState(input: {
  client: ExtensionStateKvClient;
  sessionManager: SessionManager;
  customType: string;
  value: unknown;
}): Promise<boolean> {
  const binding = findExtensionStateBinding(input.customType);
  if (!binding) {
    return false;
  }

  await input.client.writeKv(binding.scope, binding.namespace, binding.key, input.value);
  input.sessionManager.appendCustomEntry(binding.customType, input.value);
  return true;
}

export function describeManagedExtensionState(customType: string): string | undefined {
  const binding = findExtensionStateBinding(customType);
  if (!binding) {
    return undefined;
  }
  return formatBindingLabel(binding);
}
