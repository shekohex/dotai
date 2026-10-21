import { open, readFile, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

import type { MediaKind } from "../shared/contracts.js";

import { languageForPath, tokenizeLines, type LineTokens } from "./highlight.js";

const READ_MAX_BYTES = 1024 * 1024;
const HIGHLIGHT_MAX_BYTES = 300 * 1024;
const CHUNK_MAX_BYTES = 768 * 1024;

/** The absolute path of `path` inside `cwd`; anything that escapes the workspace is refused. */
function insideWorkspace(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const outside = relative(cwd, absolute);
  if (outside.startsWith("..") || isAbsolute(outside)) throw new Error(`${path} is outside the workspace`);
  return absolute;
}

const MEDIA_TYPES: Record<string, [MediaKind, string]> = {
  png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], gif: ["image", "image/gif"],
  webp: ["image", "image/webp"], avif: ["image", "image/avif"], svg: ["image", "image/svg+xml"], bmp: ["image", "image/bmp"],
  ico: ["image", "image/x-icon"],
  mp3: ["audio", "audio/mpeg"], wav: ["audio", "audio/wav"], ogg: ["audio", "audio/ogg"], oga: ["audio", "audio/ogg"],
  m4a: ["audio", "audio/mp4"], flac: ["audio", "audio/flac"], aac: ["audio", "audio/aac"], opus: ["audio", "audio/ogg"],
  mp4: ["video", "video/mp4"], m4v: ["video", "video/mp4"], webm: ["video", "video/webm"], mov: ["video", "video/quicktime"],
  ogv: ["video", "video/ogg"], mkv: ["video", "video/x-matroska"],
  pdf: ["pdf", "application/pdf"],
};

export interface FileContents {
  content: string;
  tokens: LineTokens[] | null;
  binary: boolean;
  tooLarge: boolean;
  mtimeMs: number;
  kind: MediaKind;
  mimeType: string;
  size: number;
}

export async function readWorkspaceFile(input: { cwd: string; path: string; syntax: string }): Promise<FileContents> {
  const absolute = insideWorkspace(input.cwd, input.path);
  const info = await stat(absolute);
  const [kind, mimeType] = MEDIA_TYPES[extname(input.path).slice(1).toLowerCase()] ?? ["text", "text/plain"];
  const base = { mtimeMs: info.mtimeMs, kind, mimeType, size: info.size };
  // Media is fetched in slices by the client, never as text.
  if (kind !== "text") return { ...base, content: "", tokens: null, binary: false, tooLarge: false };
  if (info.size > READ_MAX_BYTES) return { ...base, content: "", tokens: null, binary: false, tooLarge: true };
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) return { ...base, content: "", tokens: null, binary: true, tooLarge: false };
  const content = buffer.toString("utf8");
  const language = languageForPath(input.path);
  const tokens =
    language && buffer.length <= HIGHLIGHT_MAX_BYTES ? await tokenizeLines(content, language, input.syntax) : null;
  return { ...base, content, tokens, binary: false, tooLarge: false };
}

/** One slice of a file as base64. The slice length is bounded so a message stays small. */
export async function readWorkspaceFileChunk(input: {
  cwd: string;
  path: string;
  offset: number;
  length: number;
}): Promise<{ chunk: string }> {
  const handle = await open(insideWorkspace(input.cwd, input.path), "r");
  try {
    const buffer = Buffer.alloc(Math.min(input.length, CHUNK_MAX_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
    return { chunk: buffer.subarray(0, bytesRead).toString("base64") };
  } finally {
    await handle.close();
  }
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
