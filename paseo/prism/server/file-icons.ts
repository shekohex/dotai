import { createFileTreeIconResolver, getBuiltInSpriteSheet } from "@pierre/trees";

const resolver = createFileTreeIconResolver({ set: "complete", colored: true });
const SYMBOLS = new Map<string, { viewBox: string; body: string }>(
  [...getBuiltInSpriteSheet("complete").matchAll(/<symbol\s+id="([^"]+)"\s+viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g)].map(
    ([, id, viewBox, body]) => [id ?? "", { viewBox: viewBox ?? "0 0 16 16", body: body ?? "" }],
  ),
);

export interface FileIcon {
  svg: string;
  token: string | null;
}

/** One icon per file name, drawn with `currentColor` so the host can tint it. */
export function fileIconsFor(names: readonly string[]): Record<string, FileIcon> {
  const icons: Record<string, FileIcon> = {};
  for (const name of names) {
    const icon = resolver.resolveIcon("file-tree-icon-file", name);
    const symbol = SYMBOLS.get(icon.name);
    if (!symbol) continue;
    const viewBox = icon.viewBox ?? symbol.viewBox;
    icons[name] = {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${symbol.body}</svg>`,
      token: icon.token ?? null,
    };
  }
  return icons;
}
