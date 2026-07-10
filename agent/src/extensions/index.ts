import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  groupedExtensionsA,
  groupedExtensionsB,
  groupedExtensionsC,
  type GroupedExtensionDefinition,
} from "./definitions.js";
import {
  installInlineExtensionNamePatch,
  setInlineExtensionName,
} from "./inline-extension-names.js";
import { createModesExtension } from "./modes/index.js";
import type { ModeStartupSelection } from "./modes/startup-selection.js";
import { createSubagentExtension } from "./subagent.js";

export interface BundledExtensionDefinition {
  id: string;
  factory: ExtensionFactory;
}

const subagentExtensionFactory = createSubagentExtension({ enabled: true });

installInlineExtensionNamePatch();

export const bundledExtensionDefinitions: BundledExtensionDefinition[] = [
  ...groupedExtensionsA,
  ...groupedExtensionsB,
  ...groupedExtensionsC,
  { id: "subagent", factory: subagentExtensionFactory },
].map((definition) => ({
  ...definition,
  factory: setInlineExtensionName(definition.factory, definition.id),
})) satisfies GroupedExtensionDefinition[];

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

export const bundledExtensionFactories: ExtensionFactory[] = bundledExtensionDefinitions.map(
  (definition) => definition.factory,
);

export function createBundledExtensionFactories(options: {
  modeStartupSelection?: ModeStartupSelection;
}): ExtensionFactory[] {
  const modeStartupSelection = options.modeStartupSelection;
  if (modeStartupSelection?.hasExplicitModel !== true) {
    return bundledExtensionFactories;
  }

  return bundledExtensionDefinitions.map((definition) => {
    if (definition.id !== "modes") {
      return definition.factory;
    }

    return setInlineExtensionName(createModesExtension(modeStartupSelection), definition.id);
  });
}
