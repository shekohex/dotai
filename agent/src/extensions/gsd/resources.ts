import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GsdRole } from "./roles.js";
import { resolveRolePromptPath } from "./roles.js";

const rootDir = join(import.meta.dirname, "..", "..");
const gsdBundleDir = join(rootDir, "resources", "gsd");
const gsdBundlePlaceholder = "{{GSD_BUNDLE_DIR}}";

function stripLeadingFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) {
    return text;
  }

  const closingIndex = text.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return text;
  }

  return text.slice(closingIndex + 5);
}

function expandBundledPaths(text: string): string {
  return text.replaceAll(gsdBundlePlaceholder, gsdBundleDir);
}

export function loadBundledPrompt(role: GsdRole): string {
  return expandBundledPaths(
    stripLeadingFrontmatter(readFileSync(join(rootDir, resolveRolePromptPath(role)), "utf8")),
  );
}

export function loadBundledTemplate(name: string): string {
  return readFileSync(join(gsdBundleDir, "templates", name), "utf8");
}

export function loadBundledDoc(name: string): string {
  return readFileSync(join(gsdBundleDir, "docs", name), "utf8");
}

export function resolveGsdBundlePath(...segments: string[]): string {
  return join(gsdBundleDir, ...segments);
}

export function getGsdBundleDir(): string {
  return gsdBundleDir;
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replaceAll(/\[([^\]]+)\]/g, (match, name: string) => vars[name] ?? match);
}
