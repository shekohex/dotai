import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) return entry === "lang-core" ? [] : sources(file);
    return /\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") ? [file] : [];
  });
}

describe("client code", () => {
  // Hermes on Android evals the plugin bundle and leaves `class` declarations undefined, which
  // surfaces as "Element type is invalid ... got: undefined" for any class component.
  it("declares no classes", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const offenders = ["client", "shared"]
      .flatMap((dir) => sources(path.join(root, dir)))
      .filter((file) => /^\s*(export\s+)?(default\s+)?class\s/m.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
