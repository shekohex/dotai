#!/usr/bin/env node

import { main } from "@mariozechner/pi-coding-agent";
import { installBundledResourcePaths } from "./extensions/bundled-resources.js";
import { bundledExtensionFactories } from "./extensions/index.js";

process.title = "pi";

installBundledResourcePaths();
await main(process.argv.slice(2), { extensionFactories: bundledExtensionFactories });
