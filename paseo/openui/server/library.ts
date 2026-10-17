import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sourceSpecSchema, type SourceSpec, withDefaults } from "../shared/sources";
import { expandUi, type Expansion, type Library as Templates } from "../shared/template";

/** A source's `template` holds its JSON spec; see `readSource`. */
export type Kind = "component" | "program" | "source";
export type Scope = "global" | "project";

export interface Entry {
  template: string;
  description?: string;
  updatedAt: string;
}

export type Named = Entry & { name: string; scope: Scope };

/** One JSON document per kind: `{ name: Entry }`. */
export interface Store {
  read(kind: Kind): Promise<Record<string, Entry>>;
  update<T>(kind: Kind, change: (all: Record<string, Entry>) => T): Promise<T>;
}

const FILE: Record<Kind, string> = { component: "components.json", program: "programs.json", source: "sources.json" };
const KINDS: Kind[] = ["component", "program", "source"];

/** `<directory>/components.json` and `programs.json`, replaced atomically; writes to one directory are serialized. */
export class FileStore implements Store {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  async read(kind: Kind): Promise<Record<string, Entry>> {
    const raw = await readFile(path.join(this.directory, FILE[kind]), "utf8").catch(() => "{}");
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Entry>) : {};
    } catch {
      return {};
    }
  }

  update<T>(kind: Kind, change: (all: Record<string, Entry>) => T): Promise<T> {
    const run = async () => {
      const all = await this.read(kind);
      const result = change(all);
      await mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, FILE[kind]);
      await writeFile(`${file}.tmp`, `${JSON.stringify(all, null, 2)}\n`);
      await rename(`${file}.tmp`, file);
      return result;
    };
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}

export const DEFAULT_GLOBAL_DIRECTORY = path.join(homedir(), ".paseo", "openui");

/** The repository that holds `cwd` (nearest ancestor with .git, a file in worktrees), else `cwd` itself. */
export async function projectRootOf(cwd: string): Promise<string | undefined> {
  let current = path.resolve(cwd);
  if (!(await stat(current).then((info) => info.isDirectory(), () => false))) return undefined;
  for (;;) {
    if (await stat(path.join(current, ".git")).then(() => true, () => false)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export interface Snapshot {
  components: Map<string, Named>;
  programs: Map<string, Named>;
  sources: Map<string, Named>;
  templates: Templates;
}

/** The spec a saved source holds, or undefined when the file was edited into something unusable. */
export function readSource(entry: Named): SourceSpec | undefined {
  try {
    const parsed = sourceSpecSchema.safeParse(JSON.parse(entry.template));
    return parsed.success ? withDefaults(parsed.data) : undefined;
  } catch {
    return undefined;
  }
}

export type SaveResult = { saved: true; replaced?: Named; shadowed?: Named } | { saved: false; existing: Named };

/**
 * Saved components and programs in two scopes. A project's own `.paseo/openui/` files win over
 * the global ones for agents working in that project, so two projects can use the same name for
 * different things. Within one scope a name is never replaced unless the caller says so.
 */
export class Library {
  constructor(private readonly global: Store) {}

  private store(scope: Scope, projectRoot: string | undefined): Store {
    if (scope === "global") return this.global;
    if (!projectRoot) throw new Error("This agent has no project directory, so only scope global is available");
    return new FileStore(path.join(projectRoot, ".paseo", "openui"));
  }

  private async all(kind: Kind, scope: Scope, projectRoot: string | undefined): Promise<Named[]> {
    if (scope === "project" && !projectRoot) return [];
    const entries = await this.store(scope, projectRoot).read(kind);
    return Object.entries(entries)
      .filter(([, entry]) => entry && typeof entry.template === "string")
      .map(([name, entry]) => ({ name, scope, ...entry }));
  }

  async snapshot(projectRoot?: string): Promise<Snapshot> {
    const [components, programs, sources] = await Promise.all(
      KINDS.map(async (kind) => {
        const merged = new Map<string, Named>();
        for (const scope of ["global", "project"] as const) {
          for (const entry of await this.all(kind, scope, projectRoot)) merged.set(entry.name, entry);
        }
        return merged;
      }),
    );
    const templates: Templates = {
      component: (name) => components?.get(name)?.template,
      program: (name) => programs?.get(name)?.template,
    };
    return { components: components as Map<string, Named>, programs: programs as Map<string, Named>, sources: sources as Map<string, Named>, templates };
  }

  async expand(ui: string, projectRoot?: string): Promise<Expansion> {
    return expandUi(ui, (await this.snapshot(projectRoot)).templates);
  }

  async find(kind: Kind, scope: Scope, name: string, projectRoot?: string): Promise<Named | undefined> {
    return (await this.all(kind, scope, projectRoot)).find((entry) => entry.name === name);
  }

  async save(kind: Kind, scope: Scope, name: string, entry: Omit<Entry, "updatedAt">, overwrite: boolean, projectRoot?: string): Promise<SaveResult> {
    const other = await this.find(kind, scope === "global" ? "project" : "global", name, projectRoot);
    const result = await this.store(scope, projectRoot).update<SaveResult>(kind, (all) => {
      const current = all[name];
      if (current && !overwrite) return { saved: false, existing: { name, scope, ...current } };
      all[name] = { ...entry, updatedAt: new Date().toISOString() };
      return { saved: true, ...(current ? { replaced: { name, scope, ...current } } : {}) };
    });
    // A project definition hides the global one in this project; saving global under a project's name is hidden there.
    return result.saved && other ? { ...result, shadowed: other } : result;
  }

  async remove(kind: Kind, scope: Scope, name: string, projectRoot?: string): Promise<boolean> {
    return this.store(scope, projectRoot).update(kind, (all) => {
      const existed = name in all;
      delete all[name];
      return existed;
    });
  }
}
