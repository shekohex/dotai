#!/usr/bin/env node

import { main } from "@mariozechner/pi-coding-agent";
import { installBundledResourcePaths } from "./extensions/bundled-resources.js";
import { bundledExtensionFactories } from "./extensions/index.js";
import { runRemoteInteractiveMode, shouldUseRemoteMode } from "./remote/client-interactive.js";

process.title = "pi";

installBundledResourcePaths();
if (shouldUseRemoteMode(process.argv.slice(2))) {
  await runRemoteInteractiveMode(process.argv.slice(2));
} else {
  await main(process.argv.slice(2), { extensionFactories: bundledExtensionFactories });
}
