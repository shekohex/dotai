import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve, sep } from "node:path";

export interface GlancePaths {
  runtimeDir: string;
  lockDir: string;
  statusPath: string;
  statusTmpPath: string;
  clientsDir: string;
  storageDir: string;
}

export function getGlancePaths(agentDir = getAgentDir()): GlancePaths {
  const runtimeDir = join(agentDir, "runtime", "glance");
  return {
    runtimeDir,
    lockDir: join(runtimeDir, "lock"),
    statusPath: join(runtimeDir, "status.json"),
    statusTmpPath: join(runtimeDir, "status.json.tmp"),
    clientsDir: join(runtimeDir, "clients"),
    storageDir: join(runtimeDir, "storage"),
  };
}

export function isPathInsideDirectory(path: string, directory: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedDirectory = resolve(directory);
  return (
    resolvedPath === resolvedDirectory || resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  );
}

export function getClientHeartbeatPath(paths: GlancePaths, clientId: string): string {
  return join(paths.clientsDir, `${clientId}.json`);
}
