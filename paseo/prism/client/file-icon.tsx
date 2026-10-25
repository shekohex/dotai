import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useEffect, useSyncExternalStore } from "react";
import { View } from "react-native";

import { fileIconsRpc } from "../shared/contracts.js";
import { ICON_COLORS, TOKEN_COLORS } from "../shared/file-icon-colors.js";
import { appearanceOf } from "./styling.js";

interface FileIconArt {
  svg: string;
  token: string | null;
}

const BATCH_DELAY_MS = 30;
const art = new Map<string, FileIconArt>();
const requested = new Set<string>();
const listeners = new Set<() => void>();
let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Asks the daemon for the icons of the rows on screen, a batch at a time. */
function request(name: string, load: (names: string[]) => Promise<Record<string, FileIconArt>>): void {
  if (requested.has(name)) return;
  requested.add(name);
  queue.push(name);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const names = queue.splice(0, queue.length);
    load(names)
      .then((icons) => {
        for (const [key, value] of Object.entries(icons)) art.set(key, value);
        for (const listener of listeners) listener();
      })
      .catch(() => names.forEach((key) => requested.delete(key)));
  }, BATCH_DELAY_MS);
}

/**
 * Files draw Pierre's own icons, fetched as SVG from the daemon and tinted with its palette. Folders and
 * files whose icon is still loading use Lucide glyphs.
 */
export const FileIcon = memo(function FileIcon({
  theme,
  name,
  isDir,
  expanded = false,
  size = 16,
}: {
  theme: PluginTheme;
  name: string;
  isDir: boolean;
  expanded?: boolean;
  size?: number;
}) {
  const leaf = name.split("/").pop() ?? name;
  const loadIcons = useRpc(fileIconsRpc);
  const icon = useSyncExternalStore(
    subscribe,
    () => art.get(leaf),
    () => art.get(leaf),
  );
  useEffect(() => {
    if (!isDir) request(leaf, (names) => loadIcons({ names }).then((result) => result.icons));
  }, [isDir, leaf, loadIcons]);

  const dark = appearanceOf(theme) === "dark";
  const tint = icon?.token ? TOKEN_COLORS[icon.token] : undefined;
  const palette = tint ? ICON_COLORS[tint] : undefined;
  const color = isDir ? theme.colors.accent : palette ? palette[dark ? 0 : 1] : theme.colors.foregroundMuted;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      {icon && !isDir ? (
        <Icon icon={{ svg: icon.svg }} size={size} color={color} />
      ) : (
        <Icon name={isDir ? (expanded ? "FolderOpen" : "Folder") : "File"} size={size - 1} color={color} />
      )}
    </View>
  );
});
