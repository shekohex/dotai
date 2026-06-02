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

installInlineExtensionNamePatch();

function normalizeDefinitions(
  definitions: GroupedExtensionDefinition[] | undefined,
): GroupedExtensionDefinition[] {
  return definitions ?? [];
}

export function getLiteBundledExtensionFactories(): ExtensionFactory[] {
  return [
    ...normalizeDefinitions(groupedExtensionsA),
    ...normalizeDefinitions(groupedExtensionsB),
    ...normalizeDefinitions(groupedExtensionsC),
  ]
    .filter((definition) => typeof definition.factory === "function")
    .map((definition) => setInlineExtensionName(definition.factory, definition.id));
}
