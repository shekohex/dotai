import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineEntry } from "./define";
import { FileStore, Library } from "./library";

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "openui-define-"));
  const project = path.join(base, "repo");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, ".git"), "x");
  return { library: new Library(new FileStore(path.join(base, "global"))), project };
}

const badge = { name: "badge", template: 'Badge("{{label}}", "success", "Check")', description: "status pill", example: { label: "ok" } };

describe("defineEntry", () => {
  it("saves into the project by default and tests the example", async () => {
    const { library, project } = await setup();
    const result = await defineEntry(library, project, badge);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("scope project");
    expect(await library.find("component", "project", "badge", project)).toMatchObject({ description: "status pill" });
    expect(await library.find("component", "global", "badge")).toBeUndefined();
  });

  it("returns the existing definition instead of overwriting, then overwrites on request", async () => {
    const { library, project } = await setup();
    await defineEntry(library, project, badge);
    const clash = await defineEntry(library, project, { ...badge, template: 'Badge("other {{label}}")' });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain('already exists in scope project');
    expect(clash.text).toContain("Props: label");
    expect(clash.text).toContain('Badge("{{label}}", "success", "Check")');
    expect((await defineEntry(library, project, { ...badge, template: 'Badge("other {{label}}")', overwrite: true })).isError).toBe(false);
    expect((await library.find("component", "project", "badge", project))?.template).toBe('Badge("other {{label}}")');
  });

  it("lets two projects use the same name and notes shadowing of a global one", async () => {
    const { library, project } = await setup();
    expect((await defineEntry(library, undefined, { ...badge, scope: "global" })).isError).toBe(false);
    const shadow = await defineEntry(library, project, { ...badge, template: 'Badge("mine {{label}}")' });
    expect(shadow.isError).toBe(false);
    expect(shadow.text).toContain("hides the global");
  });

  it("saves programs, runs them and checks root", async () => {
    const { library, project } = await setup();
    const program = { name: "board", kind: "program" as const, template: 'root = Stack([@Use("badge", {label: {{title}}}), Text("{{note}}")])', example: { title: "T", note: "n" } };
    expect((await defineEntry(library, project, badge)).isError).toBe(false);
    const saved = await defineEntry(library, project, program);
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain("@Run(");
    expect((await library.expand('@Run("board", {title: "Hi", note: "x"})', project)).errors).toEqual([]);
    const noRoot = await defineEntry(library, project, { name: "bad", kind: "program", template: 'x = Text("a")' });
    expect(noRoot.isError).toBe(true);
    expect(noRoot.text).toContain("root");
  });

  it("rejects broken templates, bad names and project scope without a project", async () => {
    const { library, project } = await setup();
    expect((await defineEntry(library, project, { name: "x", template: "Tag({{missing}})", example: {} })).text).toContain('Missing prop "missing"');
    expect((await defineEntry(library, project, { name: "9bad", template: "Text()" })).isError).toBe(true);
    expect((await defineEntry(library, undefined, { name: "x", scope: "project", template: "Text()" })).text).toContain("no project");
    expect((await defineEntry(library, project, { name: "x", template: 'Heading(1234)', example: {} })).text).toContain("does not render");
  });

  it("deletes by kind and scope", async () => {
    const { library, project } = await setup();
    await defineEntry(library, project, badge);
    expect((await defineEntry(library, project, { name: "badge", scope: "global" })).text).toContain("scope project");
    expect((await defineEntry(library, project, { name: "badge" })).text).toContain("Deleted");
  });
});
