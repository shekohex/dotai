import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const ReferenceObjectSchema = Type.Object({
  path: Type.Optional(Type.String()),
  repository: Type.Optional(Type.String()),
  branch: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  hidden: Type.Optional(Type.Boolean()),
});

export const ReferenceEntrySchema = Type.Union([Type.String(), ReferenceObjectSchema]);

export const ReferencesConfigSchema = Type.Record(Type.String(), ReferenceEntrySchema);

export type ReferenceEntryInput = Static<typeof ReferenceEntrySchema>;
export type ReferencesConfigInput = Static<typeof ReferencesConfigSchema>;
export type ReferenceConfigScope = "global" | "project";

export type ReferenceConfig = {
  alias: string;
  sourceFile: string;
  sourceDir: string;
  path?: string;
  repository?: string;
  branch?: string;
  description?: string;
  hidden: boolean;
};

const INVALID_ALIAS_REGEX = /[/\s`,]/;

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveLocalReferencePath(input: string, sourceDir: string): string {
  const expanded = expandHome(input);
  return path.normalize(path.isAbsolute(expanded) ? expanded : path.resolve(sourceDir, expanded));
}

export function validateReferenceAlias(alias: string): string | undefined {
  if (alias.length === 0) {
    return "Reference alias cannot be empty";
  }
  if (INVALID_ALIAS_REGEX.test(alias)) {
    return "Reference alias cannot contain /, whitespace, backticks, or commas";
  }
  return undefined;
}

function parseConfigEntry(
  alias: string,
  entry: ReferenceEntryInput,
  sourceFile: string,
  sourceDir: string,
): ReferenceConfig | undefined {
  if (validateReferenceAlias(alias) !== undefined) {
    return undefined;
  }

  if (typeof entry === "string") {
    return classifyStringEntry(alias, entry, sourceFile, sourceDir);
  }

  if (entry.path !== undefined && entry.repository !== undefined) {
    return undefined;
  }

  if (entry.path === undefined && entry.repository === undefined) {
    return undefined;
  }

  return {
    alias,
    sourceFile,
    sourceDir,
    path: entry.path,
    repository: entry.repository,
    branch: entry.branch,
    description: entry.description,
    hidden: entry.hidden ?? false,
  };
}

function classifyStringEntry(
  alias: string,
  value: string,
  sourceFile: string,
  sourceDir: string,
): ReferenceConfig {
  const looksLikeLocalPath =
    value.startsWith(".") || value.startsWith("~") || path.isAbsolute(expandHome(value));
  const looksLikeRepository =
    !looksLikeLocalPath &&
    (value.startsWith("git@") ||
      value.startsWith("github:") ||
      value.startsWith("git+") ||
      value.startsWith("https://") ||
      value.startsWith("http://") ||
      /^[^/\s]+\/[^/\s]+$/.test(value));

  return {
    alias,
    sourceFile,
    sourceDir,
    path: looksLikeRepository ? undefined : value,
    repository: looksLikeRepository ? value : undefined,
    hidden: false,
  };
}

export function getReferenceConfigPath(cwd: string, scope: ReferenceConfigScope): string {
  if (scope === "global") {
    return path.join(getAgentDir(), "references.json");
  }
  return path.join(cwd, ".pi", "references.json");
}

export function getReferenceConfigPaths(cwd: string): string[] {
  return [getReferenceConfigPath(cwd, "global"), getReferenceConfigPath(cwd, "project")];
}

export async function readReferenceConfigFile(filePath: string): Promise<ReferencesConfigInput> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFoundError(error)) {
      return {};
    }
    return {};
  }

  if (!Value.Check(ReferencesConfigSchema, parsed)) {
    return {};
  }

  return Value.Parse(ReferencesConfigSchema, parsed);
}

export async function writeReferenceConfigFile(
  filePath: string,
  config: ReferencesConfigInput,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function saveReferenceConfigEntry(
  filePath: string,
  alias: string,
  entry: ReferenceEntryInput,
): Promise<void> {
  const aliasError = validateReferenceAlias(alias);
  if (aliasError !== undefined) {
    throw new Error(aliasError);
  }
  if (!Value.Check(ReferenceEntrySchema, entry)) {
    throw new Error("Invalid reference entry");
  }
  const config = await readReferenceConfigFile(filePath);
  config[alias] = entry;
  await writeReferenceConfigFile(filePath, config);
}

export async function deleteReferenceConfigEntry(filePath: string, alias: string): Promise<void> {
  const config = await readReferenceConfigFile(filePath);
  delete config[alias];
  await writeReferenceConfigFile(filePath, config);
}

export async function loadReferenceConfigs(cwd: string): Promise<ReferenceConfig[]> {
  const byAlias = new Map<string, ReferenceConfig>();
  for (const configPath of getReferenceConfigPaths(cwd)) {
    const sourceDir = path.dirname(configPath);
    const config = await readReferenceConfigFile(configPath);
    for (const [alias, entry] of Object.entries(config)) {
      const reference = parseConfigEntry(alias, entry, configPath, sourceDir);
      if (reference !== undefined) {
        byAlias.set(reference.alias, reference);
      }
    }
  }
  return Array.from(byAlias.values()).toSorted((a, b) => a.alias.localeCompare(b.alias));
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
