import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import {
  groupedExtensionsA,
  groupedExtensionsB,
  groupedExtensionsC,
  type GroupedExtensionDefinition,
} from "./definitions.js";
import { createSubagentExtension } from "./subagent.js";

export type BundledExtensionHost = "server-bound" | "ui-only";

export interface BundledExtensionDefinition {
  id: string;
  host: BundledExtensionHost;
  factory: ExtensionFactory;
}

const subagentExtensionFactory = createSubagentExtension({ enabled: false });

export const bundledExtensionDefinitions: BundledExtensionDefinition[] = [
  ...groupedExtensionsA,
  ...groupedExtensionsB,
  ...groupedExtensionsC,
  { id: "subagent", host: "server-bound", factory: subagentExtensionFactory },
] satisfies GroupedExtensionDefinition[];

const bundledExtensionDefinitionByFactory = new Map<ExtensionFactory, BundledExtensionDefinition>(
  bundledExtensionDefinitions.map((definition) => [definition.factory, definition]),
);

export function getBundledExtensionDefinitionsByHost(
  host: BundledExtensionHost,
): BundledExtensionDefinition[] {
  return bundledExtensionDefinitions.filter((definition) => definition.host === host);
}

export function findBundledExtensionDefinitionByFactory(
  factory: ExtensionFactory,
): BundledExtensionDefinition | undefined {
  return bundledExtensionDefinitionByFactory.get(factory);
}

export const bundledExtensionFactories: ExtensionFactory[] = bundledExtensionDefinitions.map(
  (definition) => definition.factory,
);
