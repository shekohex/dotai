import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileStore, Library, projectRootOf } from "./library";

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "openui-lib-"));
  const project = path.join(base, "repo");
  await mkdir(path.join(project, "src", "deep"), { recursive: true });
  await writeFile(path.join(project, ".git"), "gitdir: elsewhere");
  return { library: new Library(new FileStore(path.join(base, "global"))), project, other: path.join(base, "other") };
}

describe("Library", () => {
  it("keeps scopes apart and lets the project win", async () => {
    const { library, project } = await setup();
    await library.save("component", "global", "tag", { template: 'Tag("global {{x}}")' }, false);
    const shadow = await library.save("component", "project", "tag", { template: 'Tag("project {{x}}")' }, false, project);
    expect(shadow).toMatchObject({ saved: true, shadowed: { scope: "global" } });
    expect((await library.expand('root = @Use("tag", {x: 1})', project)).ui).toBe('root = Tag("project 1")');
    expect((await library.expand('root = @Use("tag", {x: 1})')).ui).toBe('root = Tag("global 1")');
  });

  it("does not replace a name unless asked, and reports who holds it", async () => {
    const { library, project } = await setup();
    await library.save("component", "project", "foo", { template: "A", description: "first" }, false, project);
    const clash = await library.save("component", "project", "foo", { template: "B" }, false, project);
    expect(clash).toMatchObject({ saved: false, existing: { name: "foo", template: "A", description: "first", scope: "project" } });
    const replaced = await library.save("component", "project", "foo", { template: "B" }, true, project);
    expect(replaced).toMatchObject({ saved: true, replaced: { template: "A" } });
    expect((await library.find("component", "project", "foo", project))?.template).toBe("B");
  });

  it("stores components and programs separately in the project's .paseo/openui", async () => {
    const { library, project } = await setup();
    await library.save("component", "project", "card", { template: "C" }, false, project);
    await library.save("program", "project", "card", { template: "root = P" }, false, project);
    const snapshot = await library.snapshot(project);
    expect(snapshot.components.get("card")?.template).toBe("C");
    expect(snapshot.programs.get("card")?.template).toBe("root = P");
    await expect(new FileStore(path.join(project, ".paseo", "openui")).read("program")).resolves.toHaveProperty("card");
    expect((await library.expand('@Run("card")', project)).ui).toBe("root = P");
  });

  it("refuses project scope without a project and removes by scope", async () => {
    const { library, project } = await setup();
    await expect(library.save("component", "project", "x", { template: "T" }, false)).rejects.toThrow(/no project/);
    await library.save("component", "project", "x", { template: "T" }, false, project);
    expect(await library.remove("component", "global", "x")).toBe(false);
    expect(await library.remove("component", "project", "x", project)).toBe(true);
  });

  it("finds the repository root from a nested directory", async () => {
    const { project } = await setup();
    expect(await projectRootOf(path.join(project, "src", "deep"))).toBe(project);
    expect(await projectRootOf("/definitely/not/here")).toBeUndefined();
  });
});
