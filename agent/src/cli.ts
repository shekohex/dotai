#!/usr/bin/env node

import { main } from "@earendil-works/pi-coding-agent";
import { installBundledResourcePaths } from "./extensions/bundled-resources.js";
import { bundledExtensionFactories } from "./extensions/index.js";
import { ensureRuntimeDefaultSettings } from "./runtime-default-settings.js";
import { handleWrapperUpdateCommand } from "./update/command.js";

process.title = "pi";

const args = process.argv.slice(2);

installBundledResourcePaths();
if (await handleWrapperUpdateCommand({ args })) {
  process.exit(process.exitCode ?? 0);
}
if (shouldEnsureRuntimeDefaultSettings(args)) {
  await ensureRuntimeDefaultSettings();
}

await main(args, { extensionFactories: bundledExtensionFactories });

function shouldEnsureRuntimeDefaultSettings(cliArgs: string[]): boolean {
  return !cliArgs.some(
    (arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v",
  );
}
