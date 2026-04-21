function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

export type ToolPathDisplay = {
  basename: string;
  dirSuffix: string;
};

export function shortenHome(value: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined || home.length === 0) {
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

export function splitToolPath(path: string, cwd: string): ToolPathDisplay {
  const shortenedPath = shortenPathForTool(path, cwd) || "...";
  const lastSlashIndex = shortenedPath.lastIndexOf("/");

  if (lastSlashIndex === -1) {
    return {
      basename: shortenedPath,
      dirSuffix: "./",
    };
  }

  const basename = shortenedPath.slice(lastSlashIndex + 1) || shortenedPath;
  const dirname = shortenedPath.slice(0, lastSlashIndex);

  return {
    basename,
    dirSuffix: formatToolDirSuffix(dirname),
  };
}

function formatToolDirSuffix(dirname: string): string {
  if (!dirname || dirname === ".") {
    return "./";
  }

  return `${dirname}/`;
}
