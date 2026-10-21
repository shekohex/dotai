import { Platform } from "react-native";

// DOM globals used by this module only. The project has no "DOM" lib on purpose.
const APP_SETTINGS_KEY = "@paseo:app-settings";

/** Paseo keeps its appearance settings in one JSON blob. Web and desktop only; null elsewhere. */
export function readStoredAppSettings(): string | null {
  if (Platform.OS !== "web") return null;
  try {
    return localStorage.getItem(APP_SETTINGS_KEY);
  } catch {
    return null;
  }
}

interface StyleElement {
  id: string;
  textContent: string | null;
  remove(): void;
}
declare const document: {
  readonly head: { appendChild(child: StyleElement): void };
  createElement(tag: "style"): StyleElement;
  getElementById(id: string): StyleElement | null;
};
declare const localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const HIDE_STYLE_ID = "prism-hide-builtins";
const HIDE_PREFERENCE_KEY = "prism:hide-builtin-panels";

// Stable test IDs of the built-in surfaces that Prism's panels replace.
const BUILTIN_SELECTORS = [
  '[data-testid="workspace-explorer-sidebar"] [data-testid="workspace-tab-changes_tree"]',
  '[data-testid="workspace-explorer-sidebar"] [data-testid="workspace-tab-files"]',
  '[data-testid="workspace-tab-working_diff"]',
  '[data-testid="composer-diff-stat-pill"]',
  // The "+" dropdown and the new-tab panel list every launchable view by id.
  '[data-testid="workspace-new-tab-menu-changes"]',
  '[data-testid="workspace-new-tab-menu-diff"]',
  '[data-testid="workspace-new-tab-menu-files"]',
  '[data-testid="workspace-new-tab-changes"]',
  '[data-testid="workspace-new-tab-diff"]',
  '[data-testid="workspace-new-tab-files"]',
];

/** Removes the injected rule. The saved preference is untouched. */
export function removeBuiltinHiding(): void {
  if (Platform.OS !== "web") return;
  document.getElementById(HIDE_STYLE_ID)?.remove();
}

function applyBuiltinHiding(enabled: boolean): void {
  if (Platform.OS !== "web") return;
  removeBuiltinHiding();
  if (!enabled) return;
  const style = document.createElement("style");
  style.id = HIDE_STYLE_ID;
  style.textContent = `${BUILTIN_SELECTORS.join(",\n")} { display: none !important; }`;
  document.head.appendChild(style);
}

/**
 * The host-wide setting lives in the daemon, but the app must hide built-ins before any
 * Prism panel mounts, so the last known value is mirrored here per browser profile.
 */
export function loadBuiltinHidingPreference(): boolean {
  if (Platform.OS !== "web") return true;
  try {
    // Hidden unless the user turned hiding off, matching the setting's default.
    return localStorage.getItem(HIDE_PREFERENCE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setBuiltinHiding(enabled: boolean): void {
  if (Platform.OS !== "web") return;
  try {
    localStorage.setItem(HIDE_PREFERENCE_KEY, enabled ? "1" : "0");
  } catch {
    // Storage can be unavailable; the rule below still applies for this session.
  }
  applyBuiltinHiding(enabled);
}

export function restoreBuiltinHiding(): void {
  applyBuiltinHiding(loadBuiltinHidingPreference());
}

interface KeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly isComposing: boolean;
}
declare const window: {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void, capture: boolean): void;
  readonly location: { readonly pathname: string };
};

export type ShortcutAction = "changes" | "files";

const SHORTCUT_KEYS: Record<string, ShortcutAction> = { g: "changes", e: "files" };
const SHORTCUT_SETTLE_MS = 40;
const WORKSPACE_ROUTE = /\/workspace\/([^/?#]+)/;

/**
 * Redirects Paseo's Changes (Cmd/Ctrl+Shift+G) and Files (Cmd/Ctrl+Shift+E) shortcuts to Prism.
 * Paseo's own listener runs first on `window`, so Prism opens its panel just after, and it wins.
 */
export function installShortcutRedirect(
  isEnabled: () => boolean,
  onShortcut: (action: ShortcutAction, workspaceId: string) => void,
): () => void {
  if (Platform.OS !== "web") return () => {};
  const listener = (event: KeyEvent) => {
    if (!isEnabled() || event.isComposing || event.altKey || !event.shiftKey) return;
    if (!(event.metaKey || event.ctrlKey)) return;
    const action = SHORTCUT_KEYS[event.key.toLowerCase()];
    const workspaceId = WORKSPACE_ROUTE.exec(window.location.pathname)?.[1];
    if (!action || !workspaceId) return;
    setTimeout(() => onShortcut(action, decodeURIComponent(workspaceId)), SHORTCUT_SETTLE_MS);
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}

export function formatCompact(value: number): string {
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return String(Math.round(value));
}
