import { resolve } from "node:path";

export function normalizeRemoteWorkspaceCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) {
    return undefined;
  }

  const trimmedCwd = cwd.trim();
  if (trimmedCwd.length === 0) {
    return undefined;
  }

  return resolve(trimmedCwd);
}
