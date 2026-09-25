import type { PluginThemeContribution } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";

const themes: PluginThemeContribution[] = [
  {
    id: "latte",
    name: "Catppuccin Latte",
    appearance: "light",
    colors: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      raised: "#ccd0da",
      control: "#bcc0cc",
      border: "#bcc0cc",
      accent: "#8839ef",
      mutedForeground: "#6c6f85",
      ring: "#9ca0b0",
    },
  },
  {
    id: "frappe",
    name: "Catppuccin Frappé",
    appearance: "dark",
    colors: {
      background: "#303446",
      foreground: "#c6d0f5",
      raised: "#414559",
      control: "#51576d",
      border: "#51576d",
      accent: "#ca9ee6",
      mutedForeground: "#a5adce",
      ring: "#737994",
    },
  },
  {
    id: "macchiato",
    name: "Catppuccin Macchiato",
    appearance: "dark",
    colors: {
      background: "#24273a",
      foreground: "#cad3f5",
      raised: "#363a4f",
      control: "#494d64",
      border: "#494d64",
      accent: "#c6a0f6",
      mutedForeground: "#a5adcb",
      ring: "#6e738d",
    },
  },
  {
    id: "mocha",
    name: "Catppuccin Mocha",
    appearance: "dark",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      raised: "#313244",
      control: "#45475a",
      border: "#45475a",
      accent: "#cba6f7",
      mutedForeground: "#a6adc8",
      ring: "#6c7086",
    },
  },
];

export default function contribute(client: PluginClientContext) {
  for (const theme of themes) {
    client.addTheme(theme);
  }
  return () => {};
}
