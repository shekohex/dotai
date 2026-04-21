import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const extensionDir = import.meta.dirname;
const bundledResourcesDir = join(extensionDir, "..", "resources");
const loaderPatchSymbol = Symbol.for(
  "@shekohex/agent/default-resource-loader-bundled-paths-patched",
);

type LoaderPatchState = {
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
  __shekohexBundledResourcePathsInstalled?: boolean;
};

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}

function readLoaderPatchState(loader: DefaultResourceLoader): LoaderPatchState {
  return {
    additionalSkillPaths: readOptionalStringArray(Reflect.get(loader, "additionalSkillPaths")),
    additionalPromptTemplatePaths: readOptionalStringArray(
      Reflect.get(loader, "additionalPromptTemplatePaths"),
    ),
    additionalThemePaths: readOptionalStringArray(Reflect.get(loader, "additionalThemePaths")),
    __shekohexBundledResourcePathsInstalled:
      Reflect.get(loader, "__shekohexBundledResourcePathsInstalled") === true,
  };
}

export default function bundledResourcesExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: discoverSkillPaths(),
    promptPaths: discoverPromptPaths(),
    themePaths: discoverThemePaths(),
  }));
}

export function installBundledResourcePaths(): void {
  const loaderPrototype = DefaultResourceLoader.prototype;

  if (Reflect.get(loaderPrototype, loaderPatchSymbol) === true) {
    return;
  }

  const reloadDescriptor = Object.getOwnPropertyDescriptor(loaderPrototype, "reload");
  const originalReloadValue: unknown = reloadDescriptor?.value;
  if (typeof originalReloadValue !== "function") {
    throw new TypeError("DefaultResourceLoader.reload is unavailable");
  }

  loaderPrototype.reload = async function patchedReload(
    this: DefaultResourceLoader,
  ): Promise<void> {
    const state = readLoaderPatchState(this);
    if (state.__shekohexBundledResourcePathsInstalled !== true) {
      Reflect.set(
        this,
        "additionalSkillPaths",
        appendUniquePaths(state.additionalSkillPaths, discoverSkillPaths()),
      );
      Reflect.set(
        this,
        "additionalPromptTemplatePaths",
        appendUniquePaths(state.additionalPromptTemplatePaths, discoverPromptPaths()),
      );
      Reflect.set(
        this,
        "additionalThemePaths",
        appendUniquePaths(state.additionalThemePaths, discoverThemePaths()),
      );
      Reflect.set(this, "__shekohexBundledResourcePathsInstalled", true);
    }

    await Promise.resolve(Reflect.apply(originalReloadValue, this, []));
  };

  Reflect.set(loaderPrototype, loaderPatchSymbol, true);
}

export function discoverSkillPaths(): string[] {
  return discoverFiles(join(bundledResourcesDir, "skills"), (name) => name === "SKILL.md");
}

export function discoverPromptPaths(): string[] {
  return discoverFiles(join(bundledResourcesDir, "prompts"), (name) => name.endsWith(".md"));
}

export function discoverThemePaths(): string[] {
  return discoverFiles(join(bundledResourcesDir, "themes"), (name) => name.endsWith(".json"));
}

function appendUniquePaths(current: string[] | undefined, next: string[]): string[] {
  return Array.from(new Set([...(current ?? []), ...next]));
}

function discoverFiles(dir: string, include: (name: string) => boolean): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...discoverFiles(fullPath, include));
      continue;
    }

    if (entry.isFile() && include(entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}
