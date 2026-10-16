import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PLUGIN_VERSION, pluginBuild } from "./version.js";

describe("pluginBuild", () => {
  it("matches package.json and changes with the code", async () => {
    const pkg = JSON.parse(
      await readFile(
        path.join(import.meta.dirname, "..", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(PLUGIN_VERSION).toBe(pkg.version);
    expect(pluginBuild(["a"])).toMatch(/^\d+\.\d+\.\d+ #[0-9a-f]{8}$/);
    expect(pluginBuild(["a"])).not.toBe(pluginBuild(["b"]));
  });
});
