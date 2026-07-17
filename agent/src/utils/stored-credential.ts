import { execSync } from "node:child_process";

import { readStoredCredential } from "@earendil-works/pi-coding-agent";

const commandResultCache = new Map<string, string | undefined>();
const environmentReferencePattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export function hasStoredCredential(providerId: string): boolean {
  return readStoredCredential(providerId) !== undefined;
}

export function readStoredOAuthCredential(providerId: string) {
  const credential = readStoredCredential(providerId);
  return credential?.type === "oauth" ? credential : undefined;
}

export function resolveStoredApiKey(providerId: string): string | undefined {
  const credential = readStoredCredential(providerId);
  if (credential?.type === "oauth") {
    return credential.access;
  }
  if (credential?.type !== "api_key" || credential.key === undefined) {
    return undefined;
  }
  return resolveStoredValue(credential.key, credential.env);
}

function resolveStoredValue(
  value: string,
  credentialEnvironment?: Record<string, string>,
): string | undefined {
  if (value.startsWith("!")) {
    return executeCommand(value);
  }

  const escapedDollar = "\u0000";
  const escapedBang = "\u0001";
  let missingEnvironmentValue = false;
  const resolved = value
    .replaceAll("$$", escapedDollar)
    .replaceAll("$!", escapedBang)
    .replace(
      environmentReferencePattern,
      (_match, bracedName: string | undefined, plainName: string | undefined) => {
        const name = bracedName ?? plainName ?? "";
        const environmentValue = credentialEnvironment?.[name] ?? process.env[name];
        if (environmentValue === undefined) {
          missingEnvironmentValue = true;
          return "";
        }
        return environmentValue;
      },
    )
    .replaceAll(escapedDollar, "$")
    .replaceAll(escapedBang, "!");

  return missingEnvironmentValue ? undefined : resolved;
}

function executeCommand(commandValue: string): string | undefined {
  if (commandResultCache.has(commandValue)) {
    return commandResultCache.get(commandValue);
  }

  let result: string | undefined;
  try {
    result =
      execSync(commandValue.slice(1), {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
  } catch {
    result = undefined;
  }
  commandResultCache.set(commandValue, result);
  return result;
}
