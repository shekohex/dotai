import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readProjectInstructions } from "./project-instructions.js";

describe("readProjectInstructions", () => {
  it("prefers the first directory that has a non-empty CONDUCTOR.md", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "conductor-md-"));
    const workspace = path.join(root, "workspace");
    const project = path.join(root, "project");
    await mkdir(workspace);
    await mkdir(project);
    await writeFile(path.join(workspace, "CONDUCTOR.md"), "  \n");
    await writeFile(
      path.join(project, "CONDUCTOR.md"),
      "\nAlways use codex for reviews.\n",
    );

    expect(await readProjectInstructions([workspace, project])).toEqual({
      path: path.join(project, "CONDUCTOR.md"),
      content: "Always use codex for reviews.",
    });
    expect(await readProjectInstructions([workspace])).toBeNull();
  });
});
