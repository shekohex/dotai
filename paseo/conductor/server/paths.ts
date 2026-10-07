import os from "node:os";
import path from "node:path";

export interface ConductorPaths {
  root: string;
  sharedMemoryDir: string;
  ledgerFile: string;
  conductorDir(conductorId: string): string;
}

export function resolveConductorPaths(
  root = process.env.CONDUCTOR_PASEO_HOME ??
    path.join(os.homedir(), ".paseo", "conductor"),
): ConductorPaths {
  return {
    root,
    sharedMemoryDir: path.join(root, "memory"),
    ledgerFile: path.join(root, "ledger.json"),
    conductorDir: (conductorId) => path.join(root, "conductors", conductorId),
  };
}
