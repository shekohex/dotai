import { basename } from "node:path";
import type { Args, ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  groupedExtensionsA,
  groupedExtensionsB,
  groupedExtensionsC,
  type GroupedExtensionDefinition,
} from "./definitions.js";
import { installHerdrIntegrationConflictPatch } from "./herdr-integration-conflicts.js";
import { createModesExtension } from "./modes/index.js";
import type { ModeStartupSelection } from "./modes/startup-selection.js";
import { piMcpAdapterExtensionFactory } from "./pi-mcp-adapter.js";
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
  { id: "pi-mcp-adapter", factory: piMcpAdapterExtensionFactory },
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
  parsedArgs?: Pick<Args, "extensions" | "mode">;
}): InlineExtension[] {
  const modeStartupSelection = options.modeStartupSelection;
  const omitSubagent = shouldOmitBundledSubagent(options.parsedArgs);
  if (modeStartupSelection?.hasExplicitModel !== true && !omitSubagent) {
    return bundledExtensionFactories;
  }

  return bundledExtensionDefinitions
    .filter((definition) => !omitSubagent || definition.id !== "subagent")
    .map((definition) => {
      const factory =
        definition.id === "modes" && modeStartupSelection?.hasExplicitModel === true
          ? createModesExtension(modeStartupSelection)
          : definition.factory;
      return { name: definition.id, factory };
    });
}

function shouldOmitBundledSubagent(
  parsedArgs: Pick<Args, "extensions" | "mode"> | undefined,
): boolean {
  return (
    parsedArgs?.mode === "rpc" &&
    parsedArgs.extensions?.some(
      (extensionPath) => basename(extensionPath) === "pi-t3-subagent-extension.ts",
    ) === true
  );
}
