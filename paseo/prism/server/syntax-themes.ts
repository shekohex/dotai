import { themes as catalog } from "@pierre/highlights/themes/loader";
import type { Theme } from "@pierre/highlights";

import type { SyntaxTheme } from "../shared/contracts.js";

const FALLBACK: Record<SyntaxTheme["appearance"], string> = { dark: "github-dark", light: "github-light" };

const loaded = new Map<string, Promise<Theme>>();

/** One of Highlights' bundled themes, loaded once. */
export function loadSyntaxTheme(name: string): Promise<Theme> {
  let theme = loaded.get(name);
  if (!theme) {
    const loader = (catalog as Record<string, (() => Promise<{ default: Theme }>) | undefined>)[name];
    theme = loader ? loader().then((module) => module.default) : loadSyntaxTheme(FALLBACK.dark);
    loaded.set(name, theme);
  }
  return theme;
}

interface ThemeInfo extends SyntaxTheme {
  background: string;
}

let infos: Promise<ThemeInfo[]> | null = null;

function listThemeInfos(): Promise<ThemeInfo[]> {
  infos ??= Promise.all(
    Object.keys(catalog).map(async (name): Promise<ThemeInfo> => {
      const theme = await loadSyntaxTheme(name);
      const background = theme.style["editor.background"] ?? theme.style.background;
      return {
        name,
        appearance: theme.appearance === "light" ? "light" : "dark",
        background: typeof background === "string" ? normalizeColor(background) : "",
      };
    }),
  );
  return infos;
}

function normalizeColor(color: string): string {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim())?.[1]?.toLowerCase();
  if (!hex) return color.toLowerCase();
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex.slice(0, 6);
  return `#${full}`;
}

export async function listSyntaxThemes(): Promise<SyntaxTheme[]> {
  return (await listThemeInfos()).map(({ name, appearance }) => ({ name, appearance }));
}

/**
 * "auto" finds the bundled theme whose editor background is the Paseo theme's surface color, so a
 * Catppuccin or Tokyo Night Paseo theme gets its own syntax colors. Anything else falls back to GitHub's.
 */
export async function resolveSyntaxTheme(input: {
  choice: string;
  background: string;
  appearance: SyntaxTheme["appearance"];
}): Promise<SyntaxTheme> {
  const all = await listThemeInfos();
  if (input.choice !== "auto") {
    const chosen = all.find((info) => info.name === input.choice);
    if (chosen) return { name: chosen.name, appearance: chosen.appearance };
  }
  const background = normalizeColor(input.background);
  const match = all.find((info) => info.background === background && info.appearance === input.appearance);
  if (match) return { name: match.name, appearance: match.appearance };
  return { name: FALLBACK[input.appearance], appearance: input.appearance };
}
