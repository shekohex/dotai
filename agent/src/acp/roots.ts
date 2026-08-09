import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

export class WorkspaceRoots {
  private constructor(
    readonly cwd: string,
    readonly additionalDirectories: readonly string[],
    private readonly realRoots: readonly string[],
  ) {}

  static async create(
    cwd: string,
    additionalDirectories: readonly string[],
  ): Promise<WorkspaceRoots> {
    const requestedRoots = [cwd, ...additionalDirectories].map((root) =>
      validateAbsoluteRoot(root),
    );
    if (new Set(requestedRoots).size !== requestedRoots.length) {
      throw new Error("Duplicate ACP workspace root");
    }
    const realRoots = await Promise.all(requestedRoots.map((root) => realpath(root)));
    if (new Set(realRoots).size !== realRoots.length)
      throw new Error("Duplicate ACP workspace root");
    return new WorkspaceRoots(requestedRoots[0], requestedRoots.slice(1), realRoots);
  }

  async assertExistingPath(path: string): Promise<string> {
    const absolutePath = validateAbsolutePath(path);
    const resolvedPath = await realpath(absolutePath);
    this.assertContained(resolvedPath);
    return absolutePath;
  }

  async assertCreatablePath(path: string): Promise<string> {
    const absolutePath = validateAbsolutePath(path);
    this.assertLexicallyContained(absolutePath);
    const existingParent = await nearestExistingParent(dirname(absolutePath));
    this.assertContained(await realpath(existingParent));
    return absolutePath;
  }

  private assertLexicallyContained(path: string): void {
    const roots = [this.cwd, ...this.additionalDirectories];
    if (!roots.some((root) => contains(root, path))) throw outsideRoots(path);
  }

  private assertContained(path: string): void {
    if (!this.realRoots.some((root) => contains(root, path))) throw outsideRoots(path);
  }
}

function validateAbsoluteRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error(`ACP workspace root must be absolute: ${path}`);
  return normalize(path);
}

function validateAbsolutePath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`ACP workspace path must be absolute: ${path}`);
  return resolve(path);
}

function contains(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

async function nearestExistingParent(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function outsideRoots(path: string): Error {
  return new Error(`Path is outside ACP workspace roots: ${path}`);
}
