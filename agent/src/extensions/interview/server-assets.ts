import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getErrorMessage } from "./errors.js";
import { getMediaList } from "./server-contract.js";
import type { Question } from "./schema.js";
import type { InterviewThemeConfig, ThemeMode } from "./server-contract.js";

const MAX_BODY_SIZE = 15 * 1024 * 1024;
export const MAX_IMAGES = 12;
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
export const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const FORM_DIR = join(import.meta.dirname, "form");
const THEMES_DIR = join(FORM_DIR, "themes");

export const TEMPLATE = readFileSync(join(FORM_DIR, "index.html"), "utf-8");
export const STYLES = readFileSync(join(FORM_DIR, "styles.css"), "utf-8");
export const SCRIPT = readFileSync(join(FORM_DIR, "script.js"), "utf-8");

const BUILTIN_THEMES = new Map<string, { light: string; dark: string }>([
  [
    "default",
    {
      light: readFileSync(join(THEMES_DIR, "default-light.css"), "utf-8"),
      dark: readFileSync(join(THEMES_DIR, "default-dark.css"), "utf-8"),
    },
  ],
  [
    "tufte",
    {
      light: readFileSync(join(THEMES_DIR, "tufte-light.css"), "utf-8"),
      dark: readFileSync(join(THEMES_DIR, "tufte-dark.css"), "utf-8"),
    },
  ],
]);

export class BodyTooLargeError extends Error {
  statusCode = 413;
}

export function log(verbose: boolean | undefined, message: string): void {
  if (verbose === true) {
    process.stderr.write(`[interview] ${message}\n`);
  }
}

export function safeInlineJSON(data: unknown): string {
  return JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export function normalizeThemeMode(mode: string | undefined): ThemeMode | undefined {
  return mode === "auto" || mode === "light" || mode === "dark" ? mode : undefined;
}

export function getResolvedThemeAssets(options: {
  theme: InterviewThemeConfig | undefined;
  verbose: boolean | undefined;
}): { lightCss: string; darkCss: string; mode: ThemeMode } {
  const { theme, verbose } = options;
  const themeConfig = theme ?? {};
  const resolvedThemeName =
    typeof themeConfig.name === "string" && BUILTIN_THEMES.has(themeConfig.name)
      ? themeConfig.name
      : "default";
  if (typeof themeConfig.name === "string" && !BUILTIN_THEMES.has(themeConfig.name)) {
    log(verbose, `Unknown theme "${themeConfig.name}", using "default"`);
  }

  const builtinTheme = BUILTIN_THEMES.get(resolvedThemeName) ?? BUILTIN_THEMES.get("default");
  if (builtinTheme === undefined) {
    throw new Error("Missing default theme assets");
  }

  const readThemeFile = (filePath: string, fallback: string, label: string): string => {
    try {
      return readFileSync(filePath, "utf-8");
    } catch (error) {
      log(verbose, `Failed to load ${label} theme from "${filePath}": ${getErrorMessage(error)}`);
      return fallback;
    }
  };

  return {
    lightCss:
      themeConfig.lightPath === undefined
        ? builtinTheme.light
        : readThemeFile(themeConfig.lightPath, builtinTheme.light, "light"),
    darkCss:
      themeConfig.darkPath === undefined
        ? builtinTheme.dark
        : readThemeFile(themeConfig.darkPath, builtinTheme.dark, "dark"),
    mode: normalizeThemeMode(themeConfig.mode) ?? "dark",
  };
}

export function getMaxBodySize(): number {
  return MAX_BODY_SIZE;
}

export function buildCdnScripts(questions: Question[]): string {
  const needsChartJs = questions.some((question) =>
    getMediaList(question).some((media) => media.type === "chart"),
  );
  const needsMermaid = questions.some((question) =>
    getMediaList(question).some((media) => media.type === "mermaid"),
  );
  return `${needsChartJs ? '<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>\n' : ""}${needsMermaid ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n' : ""}`;
}
