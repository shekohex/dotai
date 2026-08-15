import path from "node:path";
import type { FileFinderApi } from "@ff-labs/fff-node";
import { HOME_DIR, resolveAuxRoot, rootCovers } from "./paths.js";
import { FileFinder, SCAN_TIMEOUT_MS } from "./sdk.js";

const MAX_AUX_FINDERS = 3;
const IDLE_FINDER_TTL_MS = 5 * 60 * 1000;

interface AuxFinderEntry {
  root: string;
  finder: FileFinderApi;
  lastUsed: number;
}

export interface AuxFinderOptions {
  enableFsRootScanning: boolean;
  enableHomeDirScanning: boolean;
  onHomeDirScan?: (root: string) => void;
}

export class AuxFinderPool {
  private entries: AuxFinderEntry[] = [];
  private pending = new Map<string, Promise<AuxFinderEntry>>();

  public constructor(private readonly options: AuxFinderOptions) {}

  public async acquire(
    root: string,
    acquireOptions?: { exact?: boolean },
  ): Promise<{ finder: FileFinderApi; root: string }> {
    this.sweepIdle();
    const covering = this.entries
      .filter((entry) => {
        if (entry.finder.isDestroyed) return false;
        return acquireOptions?.exact === true ? entry.root === root : rootCovers(entry.root, root);
      })
      .toSorted((left, right) => right.root.length - left.root.length)[0];

    if (covering !== undefined) {
      covering.lastUsed = Date.now();
      return covering;
    }

    const existing = this.pending.get(root);
    if (existing !== undefined) {
      const entry = await existing;
      entry.lastUsed = Date.now();
      return entry;
    }

    const creation = this.create(root).finally(() => this.pending.delete(root));
    this.pending.set(root, creation);
    return creation;
  }

  public destroy(): void {
    for (const entry of this.entries) {
      if (!entry.finder.isDestroyed) entry.finder.destroy();
    }
    this.entries = [];
    this.pending.clear();
  }

  private async create(root: string): Promise<AuxFinderEntry> {
    if (this.entries.length >= MAX_AUX_FINDERS) {
      const oldest = this.entries.reduce((candidate, entry) =>
        entry.lastUsed < candidate.lastUsed ? entry : candidate,
      );
      if (!oldest.finder.isDestroyed) oldest.finder.destroy();
      this.entries = this.entries.filter((entry) => entry !== oldest);
    }

    if (this.options.enableHomeDirScanning && rootCovers(root, HOME_DIR)) {
      this.options.onHomeDirScan?.(root);
    }

    const result = FileFinder.create({
      basePath: root,
      aiMode: true,
      enableHomeDirScanning: this.options.enableHomeDirScanning,
      enableFsRootScanning: this.options.enableFsRootScanning,
    });
    if (!result.ok)
      throw new Error(`Failed to create aux file finder for ${root}: ${result.error}`);

    await result.value.waitForScan(SCAN_TIMEOUT_MS);
    const entry = { root, finder: result.value, lastUsed: Date.now() };
    this.entries.push(entry);
    return entry;
  }

  private sweepIdle(now = Date.now()): void {
    this.entries = this.entries.filter((entry) => {
      if (now - entry.lastUsed <= IDLE_FINDER_TTL_MS) return true;
      if (!entry.finder.isDestroyed) entry.finder.destroy();
      return false;
    });
  }
}

export function routePathConstraint(
  pathConstraint: string | undefined,
  cwd: string,
): { root: string; suffix: string } | null {
  if (pathConstraint === undefined || pathConstraint.trim().length === 0) return null;

  let candidate = pathConstraint.trim();
  if (candidate === "~" || candidate.startsWith("~/")) {
    candidate = path.join(HOME_DIR, candidate.slice(1));
  } else if (!path.isAbsolute(candidate)) {
    if (candidate !== ".." && !candidate.startsWith("../")) return null;
    candidate = path.resolve(cwd, candidate);
  }

  const relativePath = path.relative(cwd, candidate);
  if (!isOutsideWorkspacePath(relativePath)) return null;
  return resolveAuxRoot(candidate);
}

function isOutsideWorkspacePath(relativePath: string): boolean {
  return (
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  );
}
