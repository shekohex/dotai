import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineEntry } from "./define";
import { checkUi, componentsText, SOURCE_EXAMPLE, sourceIndex } from "./guide";
import { FileStore, Library, readSource } from "./library";
import { SourceRunner } from "./sources";

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "openui-defsrc-"));
  const project = path.join(base, "repo");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, ".git"), "x");
  const library = new Library(new FileStore(path.join(base, "global")));
  const runner = new SourceRunner();
  const define = (input: Parameters<typeof defineEntry>[2]) => defineEntry(library, project, input, { runner, cwd: project });
  return { library, project, define };
}

const stats = { name: "sys_stats", kind: "source" as const, description: "host load", source: { run: `echo '{"cpu": 42, "mem": 71}'`, returns: "{cpu, mem} percentages" } };

describe("defining sources", () => {
  it("test-runs a read source, saves it in the project, and shows the output shape", async () => {
    const { library, project, define } = await setup();
    const result = await define(stats);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Test run output: {"cpu":42,"mem":71}');
    expect(result.text).toContain('Query("sys_stats"');
    expect(result.text).toContain("timeout 10s");
    const saved = await library.find("source", "project", "sys_stats", project);
    expect(saved && readSource(saved)).toMatchObject({ type: "command", mode: "once", timeoutSeconds: 10, access: "read" });
  });

  it("does not save a source whose test run fails, and says why", async () => {
    const { library, project, define } = await setup();
    const result = await define({ name: "broken", kind: "source", source: { run: "echo 'db is down' >&2; exit 4" } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("exit code 4");
    expect(result.text).toContain("db is down");
    expect(await library.find("source", "project", "broken", project)).toBeUndefined();
  });

  it("explains a slow command and a bad url instead of saving them", async () => {
    const { define } = await setup();
    expect((await define({ name: "slow", kind: "source", source: { run: "sleep 5", timeoutSeconds: 0.3 } })).text).toContain("timeoutSeconds");
    expect((await define({ name: "odd", kind: "source", source: { url: "ftp://x/y" } })).text).toContain("ws://");
    expect((await define({ name: "empty", kind: "source", source: {} })).text).toContain("needs `run`");
    expect((await define({ name: "bad name!", kind: "source", source: { run: "true" } })).isError).toBe(true);
    expect((await define({ name: "w", kind: "source", source: { run: "true", mode: "stream", access: "write" } })).text).toContain("stream only reads");
  });

  it("never runs a write source to test it", async () => {
    const { project, define } = await setup();
    const marker = path.join(project, "ran");
    const result = await define({ name: "deploy", kind: "source", source: { run: `touch ${marker}; echo '{"ok":true}'`, access: "write" } });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("not test-run");
    expect(result.text).toContain("Mutation(");
    expect(existsSync(marker)).toBe(false);
  });

  it("test-runs a stream until its first frame", async () => {
    const { define } = await setup();
    const result = await define({ name: "ticks", kind: "source", source: { run: `echo '{"n":1}'; sleep 30`, mode: "stream", window: 20, timeoutSeconds: 0 } });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('{"n":1}');
    expect(result.text).toContain("no idle timeout");
    expect(result.text).toContain("pushed");
  });

  it("returns the existing source on a name clash and replaces it only on request", async () => {
    const { library, project, define } = await setup();
    await define(stats);
    const clash = await define({ ...stats, source: { run: `echo '{"other":1}'` } });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain("already exists");
    expect(clash.text).toContain("host load");
    expect(clash.text).toContain("echo '{\"cpu\"");
    const replaced = await define({ ...stats, source: { run: `echo '{"other":1}'` }, overwrite: true });
    expect(replaced.isError).toBe(false);
    expect(replaced.text).toContain("Replaced the previous source");
    expect((await library.find("source", "project", "sys_stats", project))?.template).toContain("other");
  });

  it("changes only the timeout of a saved source when given just that, without running it again", async () => {
    const { library, project, define } = await setup();
    const marker = path.join(project, "count");
    await define({ name: "counted", kind: "source", source: { run: `echo x >> ${marker}; echo '{"a":1}'` } });
    const before = (await import("node:fs/promises").then((fs) => fs.readFile(marker, "utf8"))).length;
    const patched = await define({ name: "counted", kind: "source", source: { timeoutSeconds: 90 } });
    expect(patched.isError).toBe(false);
    expect(patched.text).toContain("timeout 90s");
    expect(patched.text).toContain("not re-run");
    const saved = await library.find("source", "project", "counted", project);
    expect(saved && readSource(saved)).toMatchObject({ timeoutSeconds: 90, type: "command" });
    expect(saved?.template).toContain("echo x >>");
    expect((await import("node:fs/promises").then((fs) => fs.readFile(marker, "utf8"))).length).toBe(before);
    expect((await define({ name: "ghost", kind: "source", source: { timeoutSeconds: 5 } })).isError).toBe(true);
    expect((await define({ name: "counted", kind: "source", source: { timeoutSeconds: 5000 } })).isError).toBe(true);
  });

  it("deletes a source", async () => {
    const { library, project, define } = await setup();
    await define(stats);
    expect((await define({ name: "sys_stats", kind: "source" })).text).toContain("Deleted");
    expect(await library.find("source", "project", "sys_stats", project)).toBeUndefined();
    expect((await define({ name: "sys_stats", kind: "source" })).isError).toBe(true);
  });
});

describe("checking Query and Mutation against saved sources", () => {
  async function indexed() {
    const { library, project, define } = await setup();
    await define(stats);
    await define({ name: "deploy", kind: "source", source: { run: "true", access: "write" } });
    await define({ name: "ticks", kind: "source", source: { run: `echo '{"n":1}'; sleep 30`, mode: "stream", timeoutSeconds: 0 } });
    return sourceIndex(await library.snapshot(project));
  }

  it("accepts a Query on a read source and a Mutation on a write source", async () => {
    const sources = await indexed();
    const ui = `$every = 5\nstats = Query("sys_stats", {}, {cpu: 0}, $every)\nrun = Mutation("deploy", {env: "prod"})\nroot = Stack([Metric("CPU", stats.cpu), Button("Go", Action([@Run(run), @Run(stats)]))])`;
    expect(checkUi(ui, sources)).toEqual({ errors: [], warnings: [] });
  });

  it("names the saved sources when one is unknown", async () => {
    const sources = await indexed();
    const report = checkUi(`stats = Query("sys_stat", {}, {})\nroot = Stack([Text(stats.cpu)])`, sources);
    expect(report.errors.join()).toContain('no source named "sys_stat"');
    expect(report.errors.join()).toContain("sys_stats");
  });

  it("explains that nothing is saved yet", () => {
    const report = checkUi(`stats = Query("x", {}, {})\nroot = Stack([Text(stats.cpu)])`, new Map());
    expect(report.errors.join()).toContain("No sources are saved");
  });

  it("refuses a Query on a write source and a Mutation on a stream", async () => {
    const sources = await indexed();
    expect(checkUi(`d = Query("deploy", {}, {})\nroot = Stack([Text(d.x)])`, sources).errors.join()).toContain("Use Mutation");
    expect(checkUi(`m = Mutation("ticks", {})\nroot = Stack([Button("Go", Action([@Run(m)])), Text(m.status)])`, sources).errors.join()).toContain("is a stream");
    expect(checkUi(`s = Query("sys_stats", "oops", {})\nroot = Stack([Text(s.cpu)])`, sources).errors).toEqual([]);
  });

  it("wants a quoted source name", async () => {
    const sources = await indexed();
    expect(checkUi(`name = "sys_stats"\ns = Query(name, {}, {})\nroot = Stack([Text(s.cpu)])`, sources).errors.join()).toContain("quoted source name");
  });

  it("warns about a refresh interval on a stream and a tiny one", async () => {
    const sources = await indexed();
    expect(checkUi(`t = Query("ticks", {}, {n: 0}, 5)\nroot = Stack([Text(t.n)])`, sources).warnings.join()).toContain("pushes its own updates");
    expect(checkUi(`t = Query("sys_stats", {}, {}, 0.1)\nroot = Stack([Text(t.cpu)])`, sources).warnings.join()).toContain("raised to 0.5s");
  });

  it("keeps the guide's own example valid", async () => {
    const { library, project, define } = await setup();
    await define({ name: "sys_stats", kind: "source", source: { run: `echo '{"cpu":1,"mem":2,"load":[1,2,3]}'` } });
    expect(checkUi(SOURCE_EXAMPLE, sourceIndex(await library.snapshot(project)))).toEqual({ errors: [], warnings: [] });
    expect(componentsText(await library.snapshot(project), true)).toContain('stats = Query("sys_stats"');
  });

  it("lists sources and their rules in the guide", async () => {
    const { library, project, define } = await setup();
    await define(stats);
    const text = componentsText(await library.snapshot(project), true);
    expect(text).toContain("## Live data and actions: sources");
    expect(text).toContain('Query("sys_stats"');
    expect(text).toContain("{cpu, mem} percentages");
    expect(text).toContain("timeoutSeconds");
    expect(text).toContain("${TOKEN}");
    expect(componentsText(await library.snapshot(project), false)).not.toContain("Save a source with");
  });
});
