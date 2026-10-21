import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { languageForPath, tokenizeLines, type LineTokens } from "./highlight.js";

const READ_MAX_BYTES = 1024 * 1024;
const HIGHLIGHT_MAX_BYTES = 300 * 1024;

/** The absolute path of `path` inside `cwd`; anything that escapes the workspace is refused. */
function insideWorkspace(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const outside = relative(cwd, absolute);
  if (outside.startsWith("..") || isAbsolute(outside)) throw new Error(`${path} is outside the workspace`);
  return absolute;
}

export interface FileContents {
  content: string;
  tokens: LineTokens[] | null;
  binary: boolean;
  tooLarge: boolean;
  mtimeMs: number;
}

export async function readWorkspaceFile(input: { cwd: string; path: string; syntax: string }): Promise<FileContents> {
  const absolute = insideWorkspace(input.cwd, input.path);
  const info = await stat(absolute);
  if (info.size > READ_MAX_BYTES) return { content: "", tokens: null, binary: false, tooLarge: true, mtimeMs: info.mtimeMs };
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) return { content: "", tokens: null, binary: true, tooLarge: false, mtimeMs: info.mtimeMs };
  const content = buffer.toString("utf8");
  const language = languageForPath(input.path);
  const tokens =
    language && buffer.length <= HIGHLIGHT_MAX_BYTES ? await tokenizeLines(content, language, input.syntax) : null;
  return { content, tokens, binary: false, tooLarge: false, mtimeMs: info.mtimeMs };
}

/** Saves the file unless it changed on disk since it was read, so an edit never overwrites newer work. */
export async function writeWorkspaceFile(input: {
  cwd: string;
  path: string;
  content: string;
  expectedMtimeMs: number;
}): Promise<{ mtimeMs: number }> {
  const absolute = insideWorkspace(input.cwd, input.path);
  const current = await stat(absolute);
  if (current.mtimeMs !== input.expectedMtimeMs) throw new Error(`${input.path} changed on disk. Reload it before saving.`);
  await writeFile(absolute, input.content, "utf8");
  return { mtimeMs: (await stat(absolute)).mtimeMs };
}
