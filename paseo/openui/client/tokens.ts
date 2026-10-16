import type { PluginTheme } from "@getpaseo/plugin";
import { createContext, useContext } from "react";
import { Platform } from "react-native";

/** Paseo spacing and type scale (packages/app/src/styles/theme.ts); plugins only receive colors. */
export const GAP = { none: 0, xs: 4, s: 8, m: 12, l: 16 } as const;
export const FONT = { s: 12, m: 14, l: 16, h1: 22, h2: 18, h3: 15 } as const;
export const RADIUS = { s: 6, m: 10 } as const;
export const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

export type Colors = PluginTheme["colors"];
export type Tone = "default" | "muted" | "accent" | "success" | "warning" | "danger";

export function toneColor(colors: Colors, tone: Tone | undefined): string {
  switch (tone) {
    case "muted":
      return colors.foregroundMuted;
    case "accent":
      return colors.accent;
    case "success":
      return colors.statusSuccess;
    case "warning":
      return colors.statusWarning;
    case "danger":
      return colors.statusDanger;
    default:
      return colors.foreground;
  }
}

/** A translucent wash of a hex color; falls back to a neutral surface for other color formats. */
export function wash(color: string, fallback: string, alpha = 0.14): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return fallback;
  return `${color}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

export interface UiEnv {
  colors: Colors;
  compact: boolean;
  /** The UI reads right to left: its strings are mostly Arabic. */
  rtl: boolean;
  /** The agent whose render this is; media paths resolve against its working directory. */
  agentId: string;
  /** Interactions are off once a waiting render was answered. */
  disabled: boolean;
}

export const UiEnvContext = createContext<UiEnv | null>(null);

export function useUiEnv(): UiEnv {
  const env = useContext(UiEnvContext);
  if (!env) throw new Error("useUiEnv outside OpenUiView");
  return env;
}
