#!/usr/bin/env node

import { main } from "@mariozechner/pi-coding-agent";
import { installBundledResourcePaths } from "./extensions/bundled-resources.js";
import { bundledExtensionDefinitions, bundledExtensionFactories } from "./extensions/index.js";
import { REMOTE_DEFAULT_CLIENT_CAPABILITIES } from "./remote/capabilities.js";
import { runRemoteInteractiveMode, shouldUseRemoteMode } from "./remote/client-interactive.js";

process.title = "pi";

installBundledResourcePaths();
if (shouldUseRemoteMode(process.argv.slice(2))) {
  const clientExtensionMetadata = bundledExtensionDefinitions.map((definition) => ({
    id: definition.id,
    runtime: "client" as const,
    path: `client:${definition.id}`,
  }));
  const clientExtensionFactories = bundledExtensionDefinitions.map(
    (definition) => definition.factory,
  );
  await runRemoteInteractiveMode(process.argv.slice(2), {
    clientExtensionMetadata,
    clientExtensionFactories,
    clientCapabilities: REMOTE_DEFAULT_CLIENT_CAPABILITIES,
  });
} else {
  await main(process.argv.slice(2), { extensionFactories: bundledExtensionFactories });
}
