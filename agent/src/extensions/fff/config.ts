import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FffConfig {
  frecencyDbPath?: string;
  historyDbPath?: string;
  enableFsRootScanning: boolean;
  enableHomeDirScanning: boolean;
}

function readStringFlag(pi: ExtensionAPI, flagName: string): string | undefined {
  const value = pi.getFlag(flagName);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Flag (boolean) > env ("1"/"true" or "0"/"false") > default.
// FFF refuses to init at / unless this is set. Home dir scanning is on by
// default for pi — launching pi from $HOME is a normal flow.
function resolveBoolOpt(
  pi: ExtensionAPI,
  flagName: string,
  envName: string,
  fallback = false,
): boolean {
  const flag = pi.getFlag(flagName);
  if (typeof flag === "boolean") return flag;
  if (typeof flag === "string") return flag === "true" || flag === "1";
  const env = process.env[envName];
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  return fallback;
}

export function registerFffFlags(pi: ExtensionAPI): void {
  pi.registerFlag("fff-frecency-db", {
    description: "Path to the frecency database (overrides FFF_FRECENCY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-history-db", {
    description: "Path to the query history database (overrides FFF_HISTORY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-enable-root-scan", {
    description:
      "Allow indexing when launched from the filesystem root (also: FFF_ENABLE_ROOT_SCAN env)",
    type: "boolean",
  });

  pi.registerFlag("fff-enable-home-scan", {
    description:
      "Index the home dir when launched from $HOME (default true; also: FFF_ENABLE_HOME_SCAN)",
    type: "boolean",
  });
}

export function readFffConfig(pi: ExtensionAPI): FffConfig {
  // DB path resolution: flag > env > undefined (use fff-node defaults)
  return {
    frecencyDbPath: readStringFlag(pi, "fff-frecency-db") ?? process.env.FFF_FRECENCY_DB,
    historyDbPath: readStringFlag(pi, "fff-history-db") ?? process.env.FFF_HISTORY_DB,
    enableFsRootScanning: resolveBoolOpt(pi, "fff-enable-root-scan", "FFF_ENABLE_ROOT_SCAN"),
    enableHomeDirScanning: resolveBoolOpt(pi, "fff-enable-home-scan", "FFF_ENABLE_HOME_SCAN", true),
  };
}
