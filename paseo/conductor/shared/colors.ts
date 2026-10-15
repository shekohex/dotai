/**
 * GitHub-label-like colors for labels, tickets, and agents: the same name always gets the same
 * hue, with a light and a dark variant so the text stays readable on either theme.
 */

/** [light-theme text, dark-theme text] per hue; backgrounds and borders are tints of the text. */
const PALETTE: readonly (readonly [string, string])[] = [
  ["#1d6fd6", "#7cb4f5"], // blue
  ["#1f7a4d", "#71d19c"], // green
  ["#a35a00", "#f0b45c"], // amber
  ["#b42d5a", "#f28bb0"], // pink
  ["#6d3fc0", "#b79af2"], // violet
  ["#0f7582", "#6fd0dc"], // teal
  ["#b8431f", "#f39a78"], // orange
  ["#4b5fbd", "#9aa9f0"], // indigo
  ["#6b7a12", "#c3d36a"], // olive
  ["#8a3fa0", "#d79aea"], // purple
];

/** A stable FNV-1a hash, so a name keeps its color across sessions and devices. */
export function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (const char of name.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export interface ChipTone {
  fg: string;
  bg: string;
  border: string;
}

/** Whether a theme is dark, from its base surface color (#rgb or #rrggbb). */
export function isDarkSurface(hex: string): boolean {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? [...value].map((char) => char + char).join("")
      : value.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(
    (index) => Number.parseInt(full.slice(index, index + 2), 16) / 255,
  );
  if (
    [r, g, b].some((channel) => channel === undefined || Number.isNaN(channel))
  )
    return true;
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
}

export function chipTone(name: string, dark: boolean): ChipTone {
  const pair = PALETTE[hashName(name) % PALETTE.length] ?? PALETTE[0]!;
  const fg = dark ? pair[1] : pair[0];
  return {
    fg,
    bg: `${fg}${dark ? "26" : "1a"}`,
    border: `${fg}${dark ? "59" : "4d"}`,
  };
}
