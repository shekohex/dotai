#!/usr/bin/env node

import { main } from "@earendil-works/pi-coding-agent";
import { installBundledResourcePaths } from "./extensions/bundled-resources.js";
import { bundledExtensionFactories } from "./extensions/index.js";
import { handleWrapperUpdateCommand } from "./update/command.js";

process.title = "pi";

installBundledResourcePaths();
if (await handleWrapperUpdateCommand({ args: process.argv.slice(2) })) {
  process.exit(process.exitCode ?? 0);
}

await main(process.argv.slice(2), { extensionFactories: bundledExtensionFactories });
