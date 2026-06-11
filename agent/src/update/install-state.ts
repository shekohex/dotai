import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { InstallMethod } from "./package-manager.js";
import type { ReleaseChannel } from "./version.js";
import { WRAPPER_PACKAGE_NAME, WRAPPER_REGISTRY_URL } from "./version.js";

export const InstallStateSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  packageName: Type.String(),
  registryUrl: Type.String(),
  installMethod: Type.Union([
    Type.Literal("npm"),
    Type.Literal("pnpm"),
    Type.Literal("bun"),
    Type.Literal("yarn"),
  ]),
  channel: Type.Union([Type.Literal("latest"), Type.Literal("preview")]),
  version: Type.String(),
  commit: Type.Optional(Type.String()),
  updatedAt: Type.String(),
});

export type InstallState = Static<typeof InstallStateSchema>;

export function getInstallStatePath(agentDir = getDefaultAgentDir()): string {
  return join(agentDir, "install.json");
}

export function readInstallState(statePath = getInstallStatePath()): InstallState | undefined {
  if (!existsSync(statePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    return Value.Check(InstallStateSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeInstallState(
  input: {
    installMethod: InstallMethod;
    channel: ReleaseChannel;
    version: string;
    commit?: string;
  },
  statePath = getInstallStatePath(),
): void {
  const stateWithoutCommit: Omit<InstallState, "commit"> = {
    schemaVersion: 1,
    packageName: WRAPPER_PACKAGE_NAME,
    registryUrl: WRAPPER_REGISTRY_URL,
    installMethod: input.installMethod,
    channel: input.channel,
    version: input.version,
    updatedAt: new Date().toISOString(),
  };
  const state: InstallState =
    input.commit === undefined
      ? stateWithoutCommit
      : { ...stateWithoutCommit, commit: input.commit };
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getDefaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}
