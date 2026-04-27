export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readDeepString(value: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    const resolved = readPath(value, path);
    if (typeof resolved === "string" && resolved.trim().length > 0) {
      return resolved;
    }
  }
  return undefined;
}

export function readDeepNumber(value: unknown, paths: string[][]): number | undefined {
  for (const path of paths) {
    const resolved = readPath(value, path);
    if (typeof resolved === "number" && Number.isFinite(resolved)) {
      return resolved;
    }
  }
  return undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}
