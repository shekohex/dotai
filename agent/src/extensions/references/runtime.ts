import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadReferenceConfigs, resolveLocalReferencePath, type ReferenceConfig } from "./config.js";
import {
  ensureRepositoryCheckout,
  getRepositoryCachePath,
  parseRepositoryReference,
} from "./repository.js";

const MAX_SEARCH_FILES = 2_000;
const MAX_AUTOCOMPLETE_ITEMS = 40;
const MENTION_REGEX = /(^|[\s([{"'])(@([A-Za-z0-9_.-]+)(?:\/([^\s`'",)}\]]*))?)/g;

export type ReferenceKind = "local" | "git";

export type ResolvedReference = ReferenceConfig & {
  kind: ReferenceKind;
  resolvedPath: string;
  available: boolean;
  refreshing: boolean;
  error?: string;
  suggestion?: string;
  lastRefreshAt?: number;
};

export type ReferenceRuntimeState = {
  references: ResolvedReference[];
  byAlias: Map<string, ResolvedReference>;
};

export type ReferenceMention = {
  raw: string;
  alias: string;
  suffix: string;
  resolvedPath?: string;
  available: boolean;
  error?: string;
};

export function createReferenceRuntimeState(): ReferenceRuntimeState {
  return { references: [], byAlias: new Map() };
}

export function suggestReferenceRefreshFix(error: string, reference?: ResolvedReference): string {
  const message = error.toLowerCase();
  if (message.includes("path not found")) {
    return "Create directory or edit reference path from /references.";
  }
  if (message.includes("invalid repository reference")) {
    return "Use owner/repo, github:owner/repo, host/path, SSH URL, or HTTPS Git URL.";
  }
  if (
    message.includes("authentication failed") ||
    message.includes("could not read username") ||
    message.includes("permission denied") ||
    message.includes("publickey")
  ) {
    return "Check git credentials/SSH key, or switch reference to an accessible HTTPS/SSH URL.";
  }
  if (
    message.includes("repository not found") ||
    message.includes("not found") ||
    message.includes("does not exist")
  ) {
    return "Check repository owner/name and access permissions.";
  }
  if (
    message.includes("could not resolve host") ||
    message.includes("name or service not known") ||
    message.includes("network is unreachable") ||
    message.includes("timed out") ||
    message.includes("timeout")
  ) {
    return "Check network/DNS/VPN, then refresh reference again.";
  }
  if (
    message.includes("couldn't find remote ref") ||
    message.includes("pathspec") ||
    message.includes("invalid branch")
  ) {
    return "Check branch/ref name or clear branch to use repository default.";
  }
  if (
    message.includes("not possible to fast-forward") ||
    message.includes("local changes") ||
    message.includes("would be overwritten") ||
    message.includes("divergent")
  ) {
    const pathHint =
      reference?.resolvedPath !== undefined && reference.resolvedPath.length > 0
        ? ` at ${reference.resolvedPath}`
        : "";
    return `Cached checkout${pathHint} has local changes or diverged. Clean it, remove it, or refresh after fixing git state.`;
  }
  return "Inspect reference details, fix source/credentials/network, then refresh again.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function replaceReference(
  state: ReferenceRuntimeState,
  alias: string,
  update: (reference: ResolvedReference) => ResolvedReference,
): ResolvedReference | undefined {
  const current = state.byAlias.get(alias);
  if (current === undefined) {
    return undefined;
  }
  const next = update(current);
  state.byAlias.set(alias, next);
  state.references = state.references.map((reference) =>
    reference.alias === alias ? next : reference,
  );
  return next;
}

async function resolveReferenceConfig(
  config: ReferenceConfig,
  previous?: ResolvedReference,
): Promise<ResolvedReference | undefined> {
  if (config.path !== undefined) {
    const resolvedPath = resolveLocalReferencePath(config.path, config.sourceDir);
    const available = await pathExists(resolvedPath);
    return {
      ...config,
      kind: "local",
      resolvedPath,
      available,
      refreshing: previous?.refreshing ?? false,
      error: available ? undefined : "path not found",
      suggestion: available ? undefined : suggestReferenceRefreshFix("path not found"),
      lastRefreshAt: previous?.lastRefreshAt,
    };
  }

  if (config.repository !== undefined) {
    const repository = parseRepositoryReference(config.repository);
    if (repository === null) {
      return {
        ...config,
        kind: "git",
        resolvedPath: "",
        available: false,
        refreshing: false,
        error: `invalid repository reference: ${config.repository}`,
        suggestion: suggestReferenceRefreshFix(
          `invalid repository reference: ${config.repository}`,
        ),
        lastRefreshAt: previous?.lastRefreshAt,
      };
    }
    const resolvedPath = getRepositoryCachePath(repository);
    const available = await pathExists(resolvedPath);
    return {
      ...config,
      kind: "git",
      resolvedPath,
      available,
      refreshing: previous?.refreshing ?? false,
      error: available ? undefined : "repository not materialized",
      suggestion: available ? undefined : "Refresh reference to clone repository into local cache.",
      lastRefreshAt: previous?.lastRefreshAt,
    };
  }

  return undefined;
}

export async function reloadReferenceConfig(
  cwd: string,
  state: ReferenceRuntimeState,
): Promise<void> {
  const configs = await loadReferenceConfigs(cwd);
  const resolved: ResolvedReference[] = [];

  for (const config of configs) {
    const reference = await resolveReferenceConfig(config, state.byAlias.get(config.alias));
    if (reference !== undefined) {
      resolved.push(reference);
    }
  }

  state.references = resolved;
  state.byAlias = new Map(resolved.map((reference) => [reference.alias, reference]));
}

export async function refreshLoadedReference(
  pi: Pick<ExtensionAPI, "exec">,
  state: ReferenceRuntimeState,
  alias: string,
): Promise<ResolvedReference | undefined> {
  const reference = replaceReference(state, alias, (current) => ({
    ...current,
    refreshing: true,
    error: undefined,
  }));
  if (reference === undefined) {
    return undefined;
  }

  try {
    if (reference.kind === "local") {
      const available = await pathExists(reference.resolvedPath);
      const error = available ? undefined : "path not found";
      return replaceReference(state, alias, (current) => ({
        ...current,
        available,
        refreshing: false,
        error,
        suggestion: error === undefined ? undefined : suggestReferenceRefreshFix(error, current),
        lastRefreshAt: Date.now(),
      }));
    }

    if (reference.repository === undefined) {
      const error = "missing repository";
      return replaceReference(state, alias, (current) => ({
        ...current,
        available: false,
        refreshing: false,
        error,
        suggestion: "Edit reference and set repository URL or owner/repo shorthand.",
        lastRefreshAt: Date.now(),
      }));
    }

    const checkout = await ensureRepositoryCheckout(pi, reference.repository, reference.branch);
    return replaceReference(state, alias, (current) => ({
      ...current,
      resolvedPath: checkout.path || current.resolvedPath,
      available: checkout.ok,
      refreshing: false,
      error: checkout.ok ? undefined : checkout.error,
      suggestion: checkout.ok ? undefined : suggestReferenceRefreshFix(checkout.error, current),
      lastRefreshAt: Date.now(),
    }));
  } catch (error) {
    const message = errorMessage(error);
    return replaceReference(state, alias, (current) => ({
      ...current,
      available: false,
      refreshing: false,
      error: message,
      suggestion: suggestReferenceRefreshFix(message, current),
      lastRefreshAt: Date.now(),
    }));
  }
}

export async function refreshLoadedReferences(
  pi: Pick<ExtensionAPI, "exec">,
  state: ReferenceRuntimeState,
  options: { remoteOnly?: boolean } = {},
): Promise<void> {
  const aliases = state.references
    .filter((reference) => options.remoteOnly !== true || reference.kind === "git")
    .map((reference) => reference.alias);
  await Promise.allSettled(aliases.map((alias) => refreshLoadedReference(pi, state, alias)));
}

export async function refreshReferences(
  pi: Pick<ExtensionAPI, "exec">,
  cwd: string,
  state: ReferenceRuntimeState,
  options: { remoteOnly?: boolean } = {},
): Promise<void> {
  await reloadReferenceConfig(cwd, state);
  await refreshLoadedReferences(pi, state, options);
}

const renderReferenceGuidance = (
  references: ReadonlyArray<{ name: string; path: string; description?: string }>,
): string =>
  [
    "Project references provide additional directories that can be accessed when relevant.",
    "<available_references>",
    ...references.flatMap((reference) => [
      "  <reference>",
      `    <name>${reference.name}</name>`,
      `    <path>${reference.path}</path>`,
      ...(reference.description === undefined
        ? []
        : [`    <description>${reference.description}</description>`]),
      "  </reference>",
    ]),
    "</available_references>",
  ].join("\n");

export function buildReferencesSystemContext(state: ReferenceRuntimeState): string {
  const available = state.references
    .filter((reference) => reference.description !== undefined)
    .map((reference) => ({
      name: reference.alias,
      path: reference.resolvedPath,
      description: reference.description,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  if (available.length === 0) {
    return "";
  }
  return renderReferenceGuidance(available);
}

export function rewriteReferenceMentions(input: string, state: ReferenceRuntimeState): string {
  return input.replace(MENTION_REGEX, (...args: unknown[]) => {
    const [full, leading, mention, alias, rawSuffix] = args;
    if (
      typeof full !== "string" ||
      typeof leading !== "string" ||
      typeof mention !== "string" ||
      typeof alias !== "string"
    ) {
      return String(full);
    }
    const suffix = typeof rawSuffix === "string" ? rawSuffix : "";
    const reference = state.byAlias.get(alias);
    if (reference === undefined || !reference.available) {
      return full;
    }
    const targetPath = path.join(reference.resolvedPath, suffix);
    return `${leading}${mention} (${targetPath})`;
  });
}

export function resolveReferenceMentions(
  input: string,
  state: ReferenceRuntimeState,
): ReferenceMention[] {
  const mentions: ReferenceMention[] = [];
  const seen = new Set<string>();

  for (const match of input.matchAll(MENTION_REGEX)) {
    const raw = match[2];
    const alias = match[3];
    const suffix = match[4] ?? "";
    if (raw === undefined || alias === undefined || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    const reference = state.byAlias.get(alias);
    if (reference === undefined) {
      continue;
    }
    mentions.push({
      raw,
      alias,
      suffix,
      resolvedPath: reference.available ? path.join(reference.resolvedPath, suffix) : undefined,
      available: reference.available,
      error: reference.error,
    });
  }

  return mentions;
}

function extractReferenceToken(
  textBeforeCursor: string,
): { alias: string; suffix: string; prefix: string } | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])@([^\s@/]*)\/?([^\s@]*)$/);
  if (match === null) {
    return null;
  }
  const raw = match[0].trimStart();
  return { alias: match[1], suffix: match[2] ?? "", prefix: raw };
}

async function collectFiles(root: string, prefix: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0 && results.length < MAX_SEARCH_FILES) {
    const dir = stack.pop() ?? root;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath).replaceAll("\\", "/");
      if (results.length >= MAX_SEARCH_FILES) {
        break;
      }
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        results.push(`${relativePath}/`);
      } else if (prefix.length === 0 || relativePath.includes(prefix)) {
        results.push(relativePath);
      }
    }
  }
  return results;
}

function completeAliasItems(state: ReferenceRuntimeState, query: string): AutocompleteItem[] {
  const normalizedQuery = query.toLowerCase();
  return state.references
    .filter((reference) => !reference.hidden && reference.available)
    .filter(
      (reference) =>
        normalizedQuery.length === 0 || reference.alias.toLowerCase().startsWith(normalizedQuery),
    )
    .toSorted((left, right) => left.alias.localeCompare(right.alias))
    .slice(0, MAX_AUTOCOMPLETE_ITEMS)
    .map((reference) => ({
      value: `@${reference.alias}`,
      label: `@${reference.alias}`,
      description: reference.description ?? reference.resolvedPath,
    }));
}

async function completeReferenceFiles(
  reference: ResolvedReference,
  suffix: string,
): Promise<AutocompleteItem[]> {
  if (!reference.available) {
    return [];
  }
  return fuzzyFilter(
    await collectFiles(reference.resolvedPath, suffix),
    suffix,
    (filePath) => filePath,
  )
    .slice(0, MAX_AUTOCOMPLETE_ITEMS)
    .map((filePath) => ({
      value: `@${reference.alias}/${filePath}`,
      label: `@${reference.alias}/${filePath}`,
      description: path.join(reference.resolvedPath, filePath),
    }));
}

export function createReferencesAutocompleteProvider(
  current: AutocompleteProvider,
  state: ReferenceRuntimeState,
): AutocompleteProvider {
  return {
    triggerCharacters: ["@", ...(current.triggerCharacters ?? [])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const token = extractReferenceToken(line.slice(0, cursorCol));
      if (token === null) {
        const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        return suggestions;
      }

      if (token.alias.length > 0 && token.prefix.includes("/")) {
        const reference = state.byAlias.get(token.alias);
        if (reference !== undefined) {
          const items = await completeReferenceFiles(reference, token.suffix);
          if (items.length > 0) {
            return { prefix: token.prefix, items };
          }
        }
      }

      const aliasItems = completeAliasItems(state, token.alias);
      if (aliasItems.length > 0) {
        return { prefix: token.prefix, items: aliasItems };
      }

      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      return suggestions;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
