#!/usr/bin/env node

import { main, parseArgs } from "@earendil-works/pi-coding-agent";
import { parseAcpCommand } from "./acp/command.js";
import { runAcpServer } from "./acp/server.js";
import { runConductorCommand } from "./conductor/command.js";
import { installBundledResourcePaths } from "./extensions/bundled-resources.js";
import { createBundledExtensionFactories } from "./extensions/index.js";
import { createModeStartupSelection } from "./extensions/modes/startup-selection.js";
import { isRemoteMode, parseRemoteModeArgs, runRemoteMode } from "./remote/mode.js";
import { ensureRuntimeDefaultSettings } from "./runtime-default-settings.js";
import { handleWrapperUpdateCommand } from "./update/command.js";
import { resolveCwd } from "./utils/cwd.js";
import { errorMessage } from "./utils/error-message.js";

process.title = "pi";

const args = process.argv.slice(2);

try {
  const acpOptions = parseAcpCommand(args);
  if (acpOptions !== undefined) {
    await runAcpServer(acpOptions);
    process.exit(0);
  }
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
}

installBundledResourcePaths();
if (await handleWrapperUpdateCommand({ args })) {
  process.exit(process.exitCode ?? 0);
}

// Expand `~`/`$VAR` in the launch cwd before upstream reads process.cwd().
// Upstream's normalizePath expands tilde but not $HOME/$VAR, which would
// otherwise be treated as a relative path and produce corrupt session dirs.
const resolvedCwd = resolveCwd(process.cwd());
if (resolvedCwd !== process.cwd()) {
  try {
    process.chdir(resolvedCwd);
  } catch {
    // If the expanded path is unusable, leave the OS cwd untouched rather than
    // failing to start; upstream will report any real path issue.
  }
}

if (isRemoteMode(args)) {
  await runRemoteMode(parseRemoteModeArgs(args, resolvedCwd));
  process.exit(0);
}

if (args[0] === "conductor") {
  if (shouldEnsureRuntimeDefaultSettings(args)) {
    await ensureRuntimeDefaultSettings();
  }
  process.exitCode = await runConductorCommand(args.slice(1), { cwd: resolvedCwd });
  process.exit(process.exitCode);
}

if (shouldEnsureRuntimeDefaultSettings(args)) {
  await ensureRuntimeDefaultSettings();
}

const parsedArgs = parseArgs(args);
const modeStartupSelection = createModeStartupSelection(parsedArgs);
await main(args, {
  extensionFactories: createBundledExtensionFactories({ modeStartupSelection, parsedArgs }),
});

function shouldEnsureRuntimeDefaultSettings(cliArgs: string[]): boolean {
  return !cliArgs.some(
    (arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v",
  );
}
