import { mkdirSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

export interface SessionCatalogWatcherOptions {
  rootDir?: string;
  debounceMs?: number;
  onChange: () => Promise<void> | void;
}

export class SessionCatalogWatcher {
  private readonly rootDir: string | undefined;
  private readonly debounceMs: number;
  private readonly onChange: () => Promise<void> | void;
  private readonly watchersByDir = new Map<string, FSWatcher>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private running = false;
  private rerunRequested = false;

  constructor(options: SessionCatalogWatcherOptions) {
    this.rootDir =
      options.rootDir !== undefined && options.rootDir.length > 0
        ? resolve(options.rootDir)
        : undefined;
    this.debounceMs = options.debounceMs ?? 75;
    this.onChange = options.onChange;
  }

  start(): void {
    if (this.rootDir === undefined) {
      return;
    }

    mkdirSync(this.rootDir, { recursive: true });
    this.refreshWatchTree();
  }

  dispose(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    for (const watcher of this.watchersByDir.values()) {
      watcher.close();
    }
    this.watchersByDir.clear();

    return Promise.resolve();
  }

  private refreshWatchTree(): void {
    if (this.rootDir === undefined) {
      return;
    }

    const nextDirs = new Set(walkDirectories(this.rootDir));

    for (const [dirPath, watcher] of this.watchersByDir.entries()) {
      if (nextDirs.has(dirPath)) {
        continue;
      }
      watcher.close();
      this.watchersByDir.delete(dirPath);
    }

    for (const dirPath of nextDirs) {
      if (this.watchersByDir.has(dirPath)) {
        continue;
      }
      const watcher = watch(dirPath, () => {
        this.scheduleReconcile();
      });
      watcher.unref();
      watcher.on("error", () => {
        this.scheduleReconcile();
      });
      this.watchersByDir.set(dirPath, watcher);
    }
  }

  private scheduleReconcile(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runReconcile();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  private async runReconcile(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    this.running = true;
    try {
      this.refreshWatchTree();
      await this.onChange();
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        await this.runReconcile();
      }
    }
  }
}

function walkDirectories(rootDir: string): string[] {
  const directories = [rootDir];

  let index = 0;
  while (index < directories.length) {
    const currentDir = directories[index];
    index += 1;
    for (const entry of readDirectoryEntries(currentDir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      directories.push(resolve(currentDir, entry.name));
    }
  }

  return directories;
}

function readDirectoryEntries(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return [];
    }

    throw error;
  }
}

function isMissingDirectoryError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
