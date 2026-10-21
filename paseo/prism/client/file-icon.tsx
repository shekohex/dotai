import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo } from "react";
import { View } from "react-native";

import { ICON_COLORS } from "../shared/file-icon-colors.js";
import { appearanceOf } from "./styling.js";

type Glyph = [lucide: string, tint: keyof typeof ICON_COLORS | null];

const BY_EXTENSION: Record<string, Glyph> = {
  ts: ["FileCode", "blue"], tsx: ["FileCode", "cyan"], js: ["FileCode", "yellow"], jsx: ["FileCode", "cyan"],
  mjs: ["FileCode", "yellow"], cjs: ["FileCode", "yellow"], py: ["FileCode", "blue"], rs: ["FileCode", "orange"],
  go: ["FileCode", "cyan"], java: ["FileCode", "red"], kt: ["FileCode", "purple"], swift: ["FileCode", "orange"],
  c: ["FileCode", "blue"], h: ["FileCode", "blue"], cpp: ["FileCode", "blue"], cs: ["FileCode", "green"],
  rb: ["FileCode", "red"], php: ["FileCode", "indigo"], lua: ["FileCode", "blue"], zig: ["FileCode", "orange"],
  vue: ["FileCode", "green"], svelte: ["FileCode", "red"], astro: ["FileCode", "purple"],
  html: ["FileCode", "orange"], css: ["Palette", "indigo"], scss: ["Palette", "pink"], sass: ["Palette", "pink"],
  sh: ["FileTerminal", "green"], bash: ["FileTerminal", "green"], zsh: ["FileTerminal", "green"],
  sql: ["Database", "purple"], graphql: ["FileCode", "pink"], tf: ["FileCode", "indigo"],
  json: ["FileJson", "orange"], yml: ["FileCog", "red"], yaml: ["FileCog", "red"], toml: ["FileCog", "gray"],
  lock: ["Lock", "gray"], env: ["FileCog", "yellow"],
  md: ["FileText", "green"], mdx: ["FileText", "green"], txt: ["FileText", null],
  png: ["Image", "pink"], jpg: ["Image", "pink"], jpeg: ["Image", "pink"], gif: ["Image", "pink"],
  webp: ["Image", "pink"], avif: ["Image", "pink"], ico: ["Image", "pink"], svg: ["Image", "orange"],
  zip: ["FileArchive", "orange"], tar: ["FileArchive", "orange"], gz: ["FileArchive", "orange"], tgz: ["FileArchive", "orange"],
  wasm: ["Cpu", "indigo"],
};

const BY_NAME: Record<string, Glyph> = {
  "package.json": ["Package", "red"], "package-lock.json": ["Lock", "red"], "bun.lock": ["Lock", "mauve"],
  "bun.lockb": ["Lock", "mauve"], "yarn.lock": ["Lock", "blue"], "pnpm-lock.yaml": ["Lock", "yellow"],
  "cargo.toml": ["Package", "orange"], "cargo.lock": ["Lock", "orange"], dockerfile: ["Container", "blue"],
  ".gitignore": ["GitBranch", "vermilion"], ".gitattributes": ["GitBranch", "vermilion"],
  "tsconfig.json": ["FileCog", "blue"], license: ["FileText", null],
};

function glyphFor(name: string, isDir: boolean, expanded: boolean): Glyph {
  if (isDir) return [expanded ? "FolderOpen" : "Folder", null];
  const lower = name.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf(".") + 1);
  return BY_NAME[lower] ?? BY_EXTENSION[extension] ?? ["File", null];
}

/**
 * Native-style lists draw Lucide glyphs tinted with Pierre's icon palette. Pierre's own file icons are
 * SVG sprites, and Paseo 0.12.0 plugins can only draw Lucide names; web and desktop use the real ones.
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
  const [glyph, tint] = glyphFor(leaf, isDir, expanded);
  const dark = appearanceOf(theme) === "dark";
  const color = isDir ? theme.colors.accent : tint ? ICON_COLORS[tint]?.[dark ? 0 : 1] : undefined;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Icon
        name={glyph}
        size={size - 1}
        color={color ?? theme.colors.foregroundMuted}
      />
    </View>
  );
});
