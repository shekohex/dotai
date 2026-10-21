import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

import { readStoredAppSettings } from "./web.js";

export interface AppAppearance {
  uiScale: number;
  codeFontSize: number;
  monoFontFamily: string;
}

// Paseo's own defaults, used on native where plugins cannot read the user's settings.
const DEFAULTS: AppAppearance = { uiScale: 1, codeFontSize: 12, monoFontFamily: "" };
const POLL_MS = 2_000;
const BASE_UI_FONT_SIZE = 14;

function parse(raw: string | null): AppAppearance {
  if (!raw) return DEFAULTS;
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>;
    const number = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return {
      uiScale: number(stored.uiBaseFontSize, BASE_UI_FONT_SIZE) / BASE_UI_FONT_SIZE,
      codeFontSize: number(stored.codeFontSize, DEFAULTS.codeFontSize),
      monoFontFamily: typeof stored.monoFontFamily === "string" ? stored.monoFontFamily : "",
    };
  } catch {
    return DEFAULTS;
  }
}

let lastRaw: string | null | undefined;
let lastValue: AppAppearance = DEFAULTS;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function snapshot(): AppAppearance {
  const raw = readStoredAppSettings();
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = parse(raw);
  }
  return lastValue;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (Platform.OS === "web" && timer === null) {
    timer = setInterval(() => {
      const before = lastValue;
      if (snapshot() !== before) for (const notify of listeners) notify();
    }, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The user's font and syntax-theme settings: live on web and desktop, Paseo's defaults on native. */
export function useAppAppearance(): AppAppearance {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
