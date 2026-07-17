import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  groupedExtensionsA,
  groupedExtensionsB,
  groupedExtensionsC,
  type GroupedExtensionDefinition,
} from "./definitions.js";
import { installHerdrIntegrationConflictPatch } from "./herdr-integration-conflicts.js";
import { createModesExtension } from "./modes/index.js";
import type { ModeStartupSelection } from "./modes/startup-selection.js";
import { createSubagentExtension } from "./subagent.js";

export interface BundledExtensionDefinition {
  id: string;
  factory: ExtensionFactory;
}

const subagentExtensionFactory = createSubagentExtension({ enabled: true });

installHerdrIntegrationConflictPatch();

export const bundledExtensionDefinitions: BundledExtensionDefinition[] = [
  ...groupedExtensionsA,
  ...groupedExtensionsB,
  ...groupedExtensionsC,
  { id: "subagent", factory: subagentExtensionFactory },
] satisfies GroupedExtensionDefinition[];

const bundledExtensionDefinitionByFactory = new Map<ExtensionFactory, BundledExtensionDefinition>(
  bundledExtensionDefinitions.map((definition) => [definition.factory, definition]),
);

export function getBundledExtensionDefinitions(): BundledExtensionDefinition[] {
  return [...bundledExtensionDefinitions];
}

export function findBundledExtensionDefinitionByFactory(
  factory: ExtensionFactory,
): BundledExtensionDefinition | undefined {
  return bundledExtensionDefinitionByFactory.get(factory);
}

export const bundledExtensionFactories: InlineExtension[] = bundledExtensionDefinitions.map(
  ({ id, factory }) => ({ name: id, factory }),
);

export function createBundledExtensionFactories(options: {
  modeStartupSelection?: ModeStartupSelection;
}): InlineExtension[] {
  const modeStartupSelection = options.modeStartupSelection;
  if (modeStartupSelection?.hasExplicitModel !== true) {
    return bundledExtensionFactories;
  }

  return bundledExtensionDefinitions.map((definition) => {
    const factory =
      definition.id === "modes" ? createModesExtension(modeStartupSelection) : definition.factory;
    return { name: definition.id, factory };
  });
}
