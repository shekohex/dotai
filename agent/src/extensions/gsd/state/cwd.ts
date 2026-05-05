let lastKnownGsdCwd: string | undefined;

export function rememberGsdCwd(cwd: string): void {
  lastKnownGsdCwd = cwd;
}

export function getLastKnownGsdCwd(): string | undefined {
  return lastKnownGsdCwd;
}
