import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONDUCTOR_CORE_FILES,
  ensureConductorMemory,
  GLOBAL_CORE_FILES,
  listMemoryFiles,
} from "./memory.js";
import { resolveConductorPaths } from "./paths.js";

describe("conductor memory", () => {
  it("seeds core files once and never overwrites user edits", async () => {
    const paths = resolveConductorPaths(
      await mkdtemp(path.join(os.tmpdir(), "conductor-")),
    );
    await ensureConductorMemory(paths, "c1");
    const instructions = path.join(paths.conductorDir("c1"), "instructions.md");
    await writeFile(instructions, "edited");
    await ensureConductorMemory(paths, "c1");
    expect(await readFile(instructions, "utf8")).toBe("edited");

    const conductorFiles = await listMemoryFiles(
      paths.conductorDir("c1"),
      CONDUCTOR_CORE_FILES,
    );
    expect(conductorFiles.map((file) => file.name)).toEqual([
      "instructions.md",
      "decisions.md",
      "notes.md",
    ]);
    const globalFiles = await listMemoryFiles(
      paths.sharedMemoryDir,
      GLOBAL_CORE_FILES,
    );
    expect(globalFiles.map((file) => file.name)).toEqual(["MEMORY.md"]);
  });
});
