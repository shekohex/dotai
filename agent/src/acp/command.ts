export interface AcpCommandOptions {
  experimentalV2: boolean;
}

const CONFLICTING_FLAGS = new Set([
  "--json",
  "--print",
  "-p",
  "--mode-json",
  "--mode-rpc",
  "--mode-remote",
]);

export function parseAcpCommand(args: string[]): AcpCommandOptions | undefined {
  const canonical = args[0] === "acp";
  const modeIndex = args.indexOf("--mode");
  const alias = modeIndex >= 0 && args[modeIndex + 1] === "acp";
  if (!canonical && !alias) {
    return undefined;
  }

  const remaining = canonical
    ? args.slice(1)
    : args.filter((_, index) => index !== modeIndex && index !== modeIndex + 1);
  for (const arg of remaining) {
    if (arg === "--experimental-acp-v2") {
      continue;
    }
    if (arg === "--mode" || CONFLICTING_FLAGS.has(arg) || arg.startsWith("--mode=")) {
      throw new Error(`ACP mode cannot be combined with ${arg}`);
    }
    throw new Error(`Unknown ACP option: ${arg}`);
  }

  return { experimentalV2: remaining.includes("--experimental-acp-v2") };
}
