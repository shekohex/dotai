import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const registeredTempPaths = new Set<string>();

export function registerTempPath(tempPath: string): string {
  registeredTempPaths.add(tempPath);
  return tempPath;
}

export function createTempDirSync(prefix: string, parentDir: string = os.tmpdir()): string {
  return registerTempPath(fs.mkdtempSync(path.join(parentDir, prefix)));
}

export async function createTempDir(
  prefix: string,
  parentDir: string = os.tmpdir(),
): Promise<string> {
  return registerTempPath(await mkdtemp(path.join(parentDir, prefix)));
}

export async function cleanupRegisteredTempPaths(): Promise<void> {
  const tempPaths = [...registeredTempPaths];
  registeredTempPaths.clear();
  await Promise.all(
    tempPaths.map(async (tempPath) => {
      await fs.promises.rm(tempPath, { recursive: true, force: true });
    }),
  );
}
