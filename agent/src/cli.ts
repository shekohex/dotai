#!/usr/bin/env node

import { main } from "@mariozechner/pi-coding-agent";
import { installBundledResourcePaths } from "./extensions/bundled-resources.js";
import {
  bundledExtensionFactories,
  getBundledExtensionDefinitionsByHost,
} from "./extensions/index.js";
import { runRemoteInteractiveMode, shouldUseRemoteMode } from "./remote/client-interactive.js";

process.title = "pi";

installBundledResourcePaths();
if (shouldUseRemoteMode(process.argv.slice(2))) {
  const clientExtensionDefinitions = getBundledExtensionDefinitionsByHost("ui-only");
  const clientExtensionMetadata = clientExtensionDefinitions.map((definition) => ({
    id: definition.id,
    host: definition.host,
    path: `client:${definition.id}`,
  }));
  const clientExtensionFactories = clientExtensionDefinitions.map(
    (definition) => definition.factory,
  );
  await runRemoteInteractiveMode(process.argv.slice(2), {
    clientExtensionMetadata,
    clientExtensionFactories,
  });
} else {
  await main(process.argv.slice(2), { extensionFactories: bundledExtensionFactories });
}
