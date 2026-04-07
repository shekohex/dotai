import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const bundledResourcesDir = join(extensionDir, "..", "resources");

export default function bundledResourcesExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: discoverSkillPaths(),
    promptPaths: discoverPromptPaths(),
    themePaths: discoverThemePaths(),
  }));
}

function discoverSkillPaths(): string[] {
  return discoverFiles(join(bundledResourcesDir, "skills"), (name) => name === "SKILL.md");
}

function discoverPromptPaths(): string[] {
  return discoverFiles(join(bundledResourcesDir, "prompts"), (name) => name.endsWith(".md"));
}

function discoverThemePaths(): string[] {
  return discoverFiles(join(bundledResourcesDir, "themes"), (name) => name.endsWith(".json"));
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
