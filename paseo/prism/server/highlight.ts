import { codeToTokens, isSupportedLanguage } from "@pierre/highlights";

import { loadSyntaxTheme } from "./syntax-themes.js";

export type LineTokens = [text: string, color: string][];

const EXTENSION_ALIASES: Record<string, string> = {
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  jsonc: "json",
  mdx: "markdown",
};
const FILENAME_LANGUAGES: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  ".bashrc": "bash",
  ".zshrc": "bash",
};
const MAX_LINE_LENGTH = 2_000;

export function languageForPath(path: string): string | null {
  const name = path.split("/").pop() ?? path;
  const byName = FILENAME_LANGUAGES[name];
  if (byName && isSupportedLanguage(byName)) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const language = EXTENSION_ALIASES[extension] ?? extension;
  return isSupportedLanguage(language) ? language : null;
}

/** Tokenizes whole-file text, one entry per line. Returns null when the language is unknown or fails. */
export async function tokenizeLines(
  text: string,
  language: string,
  syntax: string,
): Promise<LineTokens[] | null> {
  try {
    const { tokens } = codeToTokens(text, {
      lang: language as never,
      theme: await loadSyntaxTheme(syntax),
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
    });
    return tokens.map((line) =>
      line.map((token): [string, string] => [token.content, token.color ?? "inherit"]),
    );
  } catch (error) {
    console.error(`[prism] highlight failed for ${language}:`, error);
    return null;
  }
}
