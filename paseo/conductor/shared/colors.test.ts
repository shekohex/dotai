import { describe, expect, it } from "vitest";

import { chipTone, hashName, isDarkSurface } from "./colors.js";

describe("chip colors", () => {
  it("give a name the same color every time, ignoring case and spaces", () => {
    expect(hashName("UI")).toBe(hashName(" ui "));
    expect(chipTone("backend", true)).toEqual(chipTone("backend", true));
  });

  it("spread different names over the palette", () => {
    const names = ["ui", "api", "docs", "T01", "T02", "T03", "infra", "auth"];
    const hues = new Set(names.map((name) => chipTone(name, false).fg));
    expect(hues.size).toBeGreaterThanOrEqual(5);
  });

  it("use the dark variant on dark themes, with tinted fills", () => {
    const light = chipTone("ui", false);
    const dark = chipTone("ui", true);
    expect(light.fg).not.toBe(dark.fg);
    expect(dark.bg).toBe(`${dark.fg}26`);
    expect(dark.border.startsWith(dark.fg)).toBe(true);
  });

  it("tell dark surfaces from light ones", () => {
    expect(isDarkSurface("#181B1A")).toBe(true);
    expect(isDarkSurface("#ffffff")).toBe(false);
    expect(isDarkSurface("#fff")).toBe(false);
  });
});
