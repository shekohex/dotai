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
  const clientExtensionMetadata = getBundledExtensionDefinitionsByHost("ui-only").map(
    (definition) => ({
      id: definition.id,
      host: definition.host,
      path: `client:${definition.id}`,
    }),
  );
  await runRemoteInteractiveMode(process.argv.slice(2), {
    clientExtensionMetadata,
  });
} else {
  await main(process.argv.slice(2), { extensionFactories: bundledExtensionFactories });
}
