import { spawn } from "node:child_process";
import { Value } from "typebox/value";

import { asRecord } from "../utils/unknown-data.js";
import {
  getDefaultConfigPath,
  GlobalConductorConfigSchema,
  readGlobalConfig,
  writeConductorConfigSchema,
  writeGlobalConfig,
} from "./config.js";
import { parseJsonValue } from "./json.js";

type ConfigPathSegment = string | number;

export async function formatConductorConfig(
  configPath = getDefaultConfigPath(),
): Promise<{ configPath: string; schemaPath: string }> {
  const config = await readGlobalConfig(configPath);
  await writeGlobalConfig(config, configPath);
  const schemaPath = await writeConductorConfigSchema(configPath);
  return { configPath, schemaPath };
}

export async function readConductorConfigValue(
  path: string | undefined,
  configPath = getDefaultConfigPath(),
): Promise<unknown> {
  return getConfigValue(await readGlobalConfig(configPath), parseConfigPath(path));
}

export async function setConductorConfigValue(
  path: string,
  valueText: string,
  configPath = getDefaultConfigPath(),
): Promise<void> {
  const config = structuredClone(await readGlobalConfig(configPath)) as unknown;
  setConfigValue(config, parseConfigPath(path), parseSetValue(valueText));
  await writeGlobalConfig(Value.Parse(GlobalConductorConfigSchema, config), configPath);
  await writeConductorConfigSchema(configPath);
}

export async function editConductorConfig(configPath = getDefaultConfigPath()): Promise<void> {
  await readGlobalConfig(configPath);
  const editor = (process.env.VISUAL ?? process.env.EDITOR)?.trim();
  if (editor === undefined || editor.length === 0) {
    throw new Error(
      [
        `No editor configured.`,
        `Set $EDITOR or $VISUAL, then run: pi conductor config edit`,
        `Config: ${configPath}`,
      ].join("\n"),
    );
  }
  await runEditor(editor, configPath);
  await readGlobalConfig(configPath);
}

export function formatConfigValue(value: unknown, json: boolean): string {
  if (json || typeof value === "object") return `${JSON.stringify(value, null, 2)}\n`;
  if (value === undefined) return "undefined\n";
  if (typeof value === "string") return `${value}\n`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}\n`;
  }
  return `${JSON.stringify(value)}\n`;
}

function parseConfigPath(path: string | undefined): ConfigPathSegment[] {
  if (path === undefined || path.trim() === "" || path.trim() === ".") return [];
  const input = path.trim().replace(/^\./u, "");
  const segments: ConfigPathSegment[] = [];
  let token = "";
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) break;
    if (char === ".") {
      pushPathToken(segments, token);
      token = "";
      continue;
    }
    if (char === "[") {
      pushPathToken(segments, token);
      token = "";
      const endIndex = input.indexOf("]", index);
      if (endIndex < 0) throw new Error(`Invalid config path: ${path}`);
      pushPathToken(segments, input.slice(index + 1, endIndex));
      index = endIndex;
      continue;
    }
    token += char;
  }
  pushPathToken(segments, token);
  return segments;
}

function pushPathToken(segments: ConfigPathSegment[], token: string): void {
  const trimmed = token.trim();
  if (trimmed.length === 0) return;
  const unquoted = trimmed.replaceAll(/^['"]|['"]$/gu, "");
  segments.push(/^\d+$/u.test(unquoted) ? Number(unquoted) : unquoted);
}

function getConfigValue(root: unknown, path: ConfigPathSegment[]): unknown {
  let current = root;
  for (const segment of path) {
    current = getChildValue(current, segment, path);
  }
  return current;
}

function getChildValue(
  current: unknown,
  segment: ConfigPathSegment,
  path: ConfigPathSegment[],
): unknown {
  if (Array.isArray(current)) {
    const index = numericIndex(segment);
    if (index === undefined || current[index] === undefined) throw pathNotFound(path);
    return current[index];
  }
  const record = asRecord(current);
  if (record === undefined || !(String(segment) in record)) throw pathNotFound(path);
  return record[String(segment)];
}

function setConfigValue(root: unknown, path: ConfigPathSegment[], value: unknown): void {
  if (path.length === 0) throw new Error("Config set path cannot be empty");
  let current = root;
  for (const segment of path.slice(0, -1)) {
    current = getChildValue(current, segment, path);
  }
  const last = path.at(-1);
  if (last === undefined) throw new Error("Config set path cannot be empty");
  if (Array.isArray(current)) {
    const index = numericIndex(last);
    if (index === undefined || current[index] === undefined) throw pathNotFound(path);
    current[index] = value;
    return;
  }
  const record = asRecord(current);
  if (record === undefined) throw pathNotFound(path);
  record[String(last)] = value;
}

function parseSetValue(valueText: string): unknown {
  try {
    return parseJsonValue(valueText, "config set value");
  } catch {
    return valueText;
  }
}

function numericIndex(segment: ConfigPathSegment): number | undefined {
  if (typeof segment === "number") return segment;
  return /^\d+$/u.test(segment) ? Number(segment) : undefined;
}

function pathNotFound(path: ConfigPathSegment[]): Error {
  return new Error(`Config path not found: ${formatPath(path)}`);
}

function formatPath(path: ConfigPathSegment[]): string {
  return path
    .map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`))
    .join("")
    .replace(/^\./u, ".");
}

function runEditor(editor: string, configPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(`${editor} ${shellQuote(configPath)}`, {
      shell: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Editor exited with ${signal ?? code}`));
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
