import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const bundledResourcesDir = join(extensionDir, "..", "resources");
const loaderPatchSymbol = Symbol.for("@shekohex/agent/default-resource-loader-bundled-paths-patched");

type LoaderPatchState = {
  additionalSkillPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalThemePaths?: string[];
  __shekohexBundledResourcePathsInstalled?: boolean;
};

type LoaderPrototype = {
  reload(this: LoaderPatchState): Promise<void>;
  [loaderPatchSymbol]?: boolean;
};

export default function bundledResourcesExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: discoverSkillPaths(),
    promptPaths: discoverPromptPaths(),
    themePaths: discoverThemePaths(),
  }));
}

export function installBundledResourcePaths(): void {
  const loaderPrototype = DefaultResourceLoader.prototype as unknown as LoaderPrototype;

  if (loaderPrototype[loaderPatchSymbol]) {
    return;
  }

  const originalReload = loaderPrototype.reload;
  loaderPrototype.reload = async function patchedReload(this: LoaderPatchState): Promise<void> {
    if (!this.__shekohexBundledResourcePathsInstalled) {
      this.additionalSkillPaths = appendUniquePaths(this.additionalSkillPaths, discoverSkillPaths());
      this.additionalPromptTemplatePaths = appendUniquePaths(this.additionalPromptTemplatePaths, discoverPromptPaths());
      this.additionalThemePaths = appendUniquePaths(this.additionalThemePaths, discoverThemePaths());
      this.__shekohexBundledResourcePathsInstalled = true;
    }

    await originalReload.call(this);
  };

  loaderPrototype[loaderPatchSymbol] = true;
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
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

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
