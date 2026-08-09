import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WorkspaceRoots } from "../../src/acp/roots.js";

describe("ACP workspace roots", () => {
  test("accepts cwd and additional directory paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "acp-roots-"));
    const cwd = join(base, "workspace");
    const additional = join(base, "shared");
    await Promise.all([mkdir(cwd), mkdir(additional)]);
    const cwdFile = join(cwd, "file.ts");
    const sharedFile = join(additional, "notes.txt");
    await Promise.all([writeFile(cwdFile, "cwd"), writeFile(sharedFile, "shared")]);
    const roots = await WorkspaceRoots.create(cwd, [additional]);

    await expect(roots.assertExistingPath(cwdFile)).resolves.toBe(cwdFile);
    await expect(roots.assertExistingPath(sharedFile)).resolves.toBe(sharedFile);
    await expect(roots.assertCreatablePath(join(cwd, "new", "file.ts"))).resolves.toBe(
      join(cwd, "new", "file.ts"),
    );
  });

  test("rejects relative and duplicate roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "acp-roots-"));
    await expect(WorkspaceRoots.create("relative", [])).rejects.toThrow("must be absolute");
    await expect(WorkspaceRoots.create(base, [join(base, ".")])).rejects.toThrow(
      "Duplicate ACP workspace root",
    );
  });

  test("rejects sibling prefixes and parent traversal", async () => {
    const base = await mkdtemp(join(tmpdir(), "acp-roots-"));
    const cwd = join(base, "work");
    const sibling = join(base, "workspace");
    await Promise.all([mkdir(cwd), mkdir(sibling)]);
    const siblingFile = join(sibling, "file.ts");
    await writeFile(siblingFile, "outside");
    const roots = await WorkspaceRoots.create(cwd, []);

    await expect(roots.assertExistingPath(siblingFile)).rejects.toThrow(
      "outside ACP workspace roots",
    );
    await expect(roots.assertCreatablePath(join(cwd, "..", "escape.ts"))).rejects.toThrow(
      "outside ACP workspace roots",
    );
  });

  test("rejects existing and create-parent symlink escapes", async () => {
    const base = await mkdtemp(join(tmpdir(), "acp-roots-"));
    const cwd = join(base, "workspace");
    const outside = join(base, "outside");
    await Promise.all([mkdir(cwd), mkdir(outside)]);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(cwd, "escape"));
    const roots = await WorkspaceRoots.create(cwd, []);

    await expect(roots.assertExistingPath(join(cwd, "escape", "secret.txt"))).rejects.toThrow(
      "outside ACP workspace roots",
    );
    await expect(roots.assertCreatablePath(join(cwd, "escape", "new.txt"))).rejects.toThrow(
      "outside ACP workspace roots",
    );
  });
});
