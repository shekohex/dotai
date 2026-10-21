import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo } from "react";
import { View } from "react-native";

const CODE = new Set("ts tsx js jsx mjs cjs py rs go java kt swift c h cpp cs rb php lua sh html css scss vue svelte sql".split(" "));
const IMAGE = new Set("png jpg jpeg gif svg ico webp avif".split(" "));
const ARCHIVE = new Set("zip tar gz tgz".split(" "));

function glyphFor(name: string, isDir: boolean, expanded: boolean): string {
  if (isDir) return expanded ? "FolderOpen" : "Folder";
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "json") return "FileJson";
  if (CODE.has(extension)) return "FileCode";
  if (IMAGE.has(extension)) return "Image";
  if (ARCHIVE.has(extension)) return "FileArchive";
  if (extension === "md" || extension === "txt") return "FileText";
  return "File";
}

/** Fallback icons for the native-style lists; web and desktop use Pierre's own file icons. */
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
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Icon
        name={glyphFor(leaf, isDir, expanded)}
        size={size - 1}
        color={isDir ? theme.colors.accent : theme.colors.foregroundMuted}
      />
    </View>
  );
});
