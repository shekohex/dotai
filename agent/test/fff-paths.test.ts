import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { routePathConstraint } from "../src/extensions/fff/aux-finders.js";
import { normalizePathConstraint } from "../src/extensions/fff/query.js";

describe("FFF path routing", () => {
  it("keeps recursive workspace globs at workspace root", () => {
    expect(normalizePathConstraint("**", "/workspace")).toBeNull();
    expect(normalizePathConstraint("**/*", "/workspace")).toBeNull();
  });

  it("routes external files through their existing parent directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fff-workspace-"));
    const external = await mkdtemp(join(tmpdir(), "fff-external-"));
    await mkdir(join(external, "src"));
    await writeFile(join(external, "src", "file.ts"), "export const value = 1;\n");

    expect(routePathConstraint(join(external, "src", "file.ts"), workspace)).toEqual({
      root: join(external, "src"),
      suffix: "file.ts",
    });
  });
});
