import { Platform } from "react-native";
import type { AppAppearance } from "./appearance.js";
import type { PluginTheme } from "@getpaseo/plugin";

import type { ChangedFile } from "../shared/contracts.js";
import type { PierreColors, PierreFont } from "../shared/pierre-api.js";

export const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

/** Appends an alpha channel to a hex color; other formats pass through unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  return `#${full}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

const STATUS_LETTER: Record<ChangedFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "A",
  conflicted: "U",
};

export function statusLetter(status: ChangedFile["status"]): string {
  return STATUS_LETTER[status];
}

export function statusColor(theme: PluginTheme, status: ChangedFile["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return theme.colors.statusSuccess;
    case "deleted":
    case "conflicted":
      return theme.colors.statusDanger;
    default:
      return theme.colors.statusWarning;
  }
}

export function rowHeight(compact: boolean): number {
  return compact ? 44 : 28;
}

/** Paseo themes expose colors only, so the appearance comes from the surface's brightness. */
export function appearanceOf(theme: PluginTheme): "dark" | "light" {
  const hex = /^#([0-9a-f]{6})/i.exec(theme.colors.surface0)?.[1];
  if (!hex) return "dark";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0) > 140 ? "light" : "dark";
}

export interface Typography {
  ui: number;
  small: number;
  code: number;
  mono: string;
}

/** Sizes follow the user's settings on web and desktop; native uses Paseo's defaults. */
export function typographyFor(appearance: AppAppearance, compact: boolean): Typography {
  const ui = Math.round((compact ? 15 : 13) * appearance.uiScale);
  return {
    ui,
    small: Math.max(10, Math.round(ui * 0.88)),
    code: appearance.codeFontSize,
    mono: appearance.monoFontFamily === "" ? (MONO_FONT as string) : appearance.monoFontFamily,
  };
}

/**
 * Paseo forces its UI font on all web text except subtrees tagged `data-pmono`.
 * Spread this onto a View that wraps code so its monospace font survives.
 */
export const CODE_SURFACE_PROPS = { dataSet: { pmono: "" } } as object;

export function pierreColorsOf(theme: PluginTheme): PierreColors {
  const { colors } = theme;
  return {
    surface0: colors.surface0,
    surface1: colors.surface1,
    surface2: colors.surface2,
    border: colors.border,
    foreground: colors.foreground,
    foregroundMuted: colors.foregroundMuted,
    accent: colors.accent,
    success: colors.statusSuccess,
    warning: colors.statusWarning,
    danger: colors.statusDanger,
  };
}

/** The user's coding font for Pierre's shadow DOM, which the app's own font rules cannot reach. */
export function pierreFontOf(typo: Typography): PierreFont {
  return {
    family: `${typo.mono}, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
    size: typo.code,
    lineHeight: Math.round(typo.code * 1.55),
  };
}
