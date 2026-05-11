/**
 * Note-taking app integrations (Obsidian, Bear, Octarine). Node.js equivalents of
 * packages/server/integrations.ts. Config types, save functions, tag extraction, filename
 * generation
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  type ObsidianConfig,
  type BearConfig,
  type OctarineConfig,
  type IntegrationResult,
  extractTitle,
  generateFrontmatter,
  generateFilename,
  generateOctarineFrontmatter,
  stripH1,
  buildHashtags,
  buildBearContent,
  detectObsidianVaults,
} from "../generated/integrations-common.js";
import { sanitizeTag } from "../generated/project.js";
import { resolveUserPath } from "../generated/resolve-file.js";
import { errorMessage } from "../../../utils/error-message.js";

export type { ObsidianConfig, BearConfig, OctarineConfig, IntegrationResult };
export {
  extractTitle,
  generateFrontmatter,
  generateFilename,
  generateOctarineFrontmatter,
  stripH1,
  buildHashtags,
  buildBearContent,
  detectObsidianVaults,
};

/**
 * Detect project name from git or cwd.
 *
 * @returns {string | null} Sanitized project name when available.
 */
function detectProjectNameSync(): string | null {
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (toplevel.length > 0) {
      const name = sanitizeTag(basename(toplevel));
      if (name !== undefined) return name;
    }
  } catch {
    /* not in a git repo */
  }
  try {
    return sanitizeTag(basename(process.cwd())) ?? null;
  } catch {
    return null;
  }
}

export function extractTags(markdown: string): string[] {
  const tags = new Set<string>(["plannotator"]);
  const projectName = detectProjectNameSync();
  if (projectName !== null) tags.add(projectName);
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "into",
    "plan",
    "implementation",
    "overview",
    "phase",
    "step",
    "steps",
  ]);
  const h1Match = markdown.match(/^#\s+(?:Implementation\s+Plan:|Plan:)?\s*(.+)$/im);
  if (h1Match !== null) {
    h1Match[1]
      .toLowerCase()
      .replaceAll(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
      .slice(0, 3)
      .forEach((w) => tags.add(w));
  }
  const seenLangs = new Set<string>();
  let langMatch: RegExpExecArray | null;
  const langRegex = /```(\w+)/g;
  while ((langMatch = langRegex.exec(markdown)) !== null) {
    const lang = langMatch[1];
    const n = lang.toLowerCase();
    if (
      !seenLangs.has(n) &&
      !["json", "yaml", "yml", "text", "txt", "markdown", "md"].includes(n)
    ) {
      seenLangs.add(n);
      tags.add(n);
    }
  }
  return Array.from(tags).slice(0, 7);
}

export function saveToObsidian(config: ObsidianConfig): Promise<IntegrationResult> {
  try {
    const { vaultPath, folder, plan } = config;
    if (!vaultPath?.trim()) {
      return Promise.resolve({ success: false, error: "Vault path is required" });
    }
    const normalizedVault = resolveUserPath(vaultPath);
    if (!existsSync(normalizedVault))
      return Promise.resolve({
        success: false,
        error: `Vault path does not exist: ${normalizedVault}`,
      });
    if (!statSync(normalizedVault).isDirectory())
      return Promise.resolve({
        success: false,
        error: `Vault path is not a directory: ${normalizedVault}`,
      });
    const trimmedFolderName = folder.trim();
    const folderName = trimmedFolderName.length > 0 ? trimmedFolderName : "plannotator";
    const targetFolder = join(normalizedVault, folderName);
    if (!existsSync(targetFolder)) mkdirSync(targetFolder, { recursive: true });
    const filename = generateFilename(plan, config.filenameFormat, config.filenameSeparator);
    const filePath = join(targetFolder, filename);
    const tags = extractTags(plan);
    const frontmatter = generateFrontmatter(tags);
    const content = `${frontmatter}\n\n[[Plannotator Plans]]\n\n${plan}`;
    writeFileSync(filePath, content);
    return Promise.resolve({ success: true, path: filePath });
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: errorMessage(err),
    });
  }
}

export function saveToBear(config: BearConfig): Promise<IntegrationResult> {
  try {
    const { plan, customTags, tagPosition = "append" } = config;
    const title = extractTitle(plan);
    const body = stripH1(plan);
    const hasCustomTags = customTags !== undefined && customTags.trim().length > 0;
    const tags = hasCustomTags ? undefined : extractTags(plan);
    const hashtags = buildHashtags(customTags, tags ?? []);
    const content = buildBearContent(body, hashtags, tagPosition);
    const url = `bear://x-callback-url/create?title=${encodeURIComponent(title)}&text=${encodeURIComponent(content)}&open_note=no`;
    spawn("open", [url], { stdio: "ignore" });
    return Promise.resolve({ success: true });
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: errorMessage(err),
    });
  }
}

export function saveToOctarine(config: OctarineConfig): Promise<IntegrationResult> {
  try {
    const { plan } = config;
    const workspace = config.workspace.trim();
    if (workspace.length === 0)
      return Promise.resolve({ success: false, error: "Workspace is required" });
    const trimmedFolder = config.folder.trim();
    const folder = trimmedFolder.length > 0 ? trimmedFolder : "plannotator";
    const filename = generateFilename(plan);
    const base = filename.replace(/\.md$/, "");
    const path = folder ? `${folder}/${base}` : base;
    const tags = extractTags(plan);
    const frontmatter = generateOctarineFrontmatter(tags);
    const content = `${frontmatter}\n\n${plan}`;
    const url = `octarine://create?path=${encodeURIComponent(path)}&content=${encodeURIComponent(content)}&workspace=${encodeURIComponent(workspace)}&fresh=true&openAfter=false`;
    spawn("open", [url], { stdio: "ignore" });
    return Promise.resolve({ success: true, path });
  } catch (err) {
    return Promise.resolve({
      success: false,
      error: errorMessage(err),
    });
  }
}
