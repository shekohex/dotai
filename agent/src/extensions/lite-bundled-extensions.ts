import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import {
  groupedExtensionsA,
  groupedExtensionsB,
  groupedExtensionsC,
  type GroupedExtensionDefinition,
} from "./definitions.js";
function normalizeDefinitions(
  definitions: GroupedExtensionDefinition[] | undefined,
): GroupedExtensionDefinition[] {
  return definitions ?? [];
}

export function getLiteBundledExtensionFactories(options?: {
  excludeIds?: readonly string[];
}): InlineExtension[] {
  const excludedIds = new Set(options?.excludeIds ?? []);
  return [
    ...normalizeDefinitions(groupedExtensionsA),
    ...normalizeDefinitions(groupedExtensionsB),
    ...normalizeDefinitions(groupedExtensionsC),
  ]
    .filter((definition) => !excludedIds.has(definition.id))
    .filter((definition) => typeof definition.factory === "function")
    .map(({ id, factory }) => ({ name: id, factory }));
}
