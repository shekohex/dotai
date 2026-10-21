// Icon colors by token, from Trees' own palette (dark / light).
export const ICON_COLORS: Record<string, [dark: string, light: string]> = {
  gray: ["#adadb1", "#84848a"],
  red: ["#ff6762", "#d52c36"],
  orange: ["#ffa359", "#d47628"],
  yellow: ["#ffd452", "#d5a910"],
  green: ["#5ecc71", "#199f43"],
  teal: ["#64d1db", "#17a5af"],
  cyan: ["#68cdf2", "#1ca1c7"],
  blue: ["#69b1ff", "#1a85d4"],
  indigo: ["#9d6afb", "#693acf"],
  purple: ["#d568ea", "#a631be"],
  pink: ["#ff678d", "#d32a61"],
  mauve: ["#79697b", "#594c5b"],
  vermilion: ["#d5512f", "#ff8c5b"],
};
export const TOKEN_COLORS: Record<string, string> = {
  astro: "purple", babel: "yellow", bash: "green", biome: "blue", bootstrap: "indigo", browserslist: "yellow",
  bun: "mauve", c: "blue", cpp: "blue", claude: "orange", css: "indigo", database: "purple", docker: "blue",
  eslint: "indigo", git: "vermilion", go: "cyan", graphql: "pink", html: "orange", image: "pink",
  javascript: "yellow", json: "orange", markdown: "green", mcp: "teal", npm: "red", oxc: "cyan",
  postcss: "red", prettier: "teal", python: "blue", react: "cyan", ruby: "red", rust: "orange", sass: "pink",
  svg: "orange", svelte: "red", svgo: "green", swift: "orange", table: "teal", tailwind: "cyan",
  terraform: "indigo", typescript: "blue", vite: "purple", vscode: "blue", vue: "green", wasm: "indigo",
  webpack: "blue", yml: "red", zig: "orange", zip: "orange",
};
