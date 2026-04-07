function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

export function shortenHome(value: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    return value;
  }

  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export function shortenPathForTool(path: string, cwd: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedCwd = normalizePath(cwd);

  if (isAbsolutePath(normalizedPath)) {
    if (normalizedPath === normalizedCwd) {
      return ".";
    }

    if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
      const relativePath = normalizedPath.slice(normalizedCwd.length + 1);
      return relativePath ? `./${relativePath}` : ".";
    }
  }

  return shortenHome(path);
}
