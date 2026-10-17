import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineEntry } from "./define";
import { FileStore, Library } from "./library";
import { SourceService } from "./source-service";
import { SourceRunner, StreamHub } from "./sources";

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "openui-svc-"));
  const project = path.join(base, "repo");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, ".git"), "x");
  const library = new Library(new FileStore(path.join(base, "global")));
  const runner = new SourceRunner();
  const service = new SourceService(library, runner, new StreamHub(runner));
  const define = (input: Parameters<typeof defineEntry>[2]) => defineEntry(library, project, input, { runner, cwd: project });
  const agent = { id: "agent-1", cwd: project, projectRoot: project };
  return { service, define, agent, project };
}

describe("SourceService", () => {
  it("runs a saved source and passes args through", async () => {
    const { service, define, agent } = await setup();
    await define({ name: "echo", kind: "source", source: { run: "cat" } });
    expect(await service.call(agent, "echo", { host: "a" }, "query")).toEqual({ ok: true, mode: "once", data: { args: { host: "a" } } });
    service.close();
  });

  it("reports an unknown source with the saved names", async () => {
    const { service, define, agent } = await setup();
    await define({ name: "known", kind: "source", source: { run: "echo '{}'" } });
    const result = await service.call(agent, "nope", {}, "query");
    expect(result).toMatchObject({ ok: false, error: { kind: "unknown-source" } });
    expect(JSON.stringify(result)).toContain("known");
    service.close();
  });

  it("keeps write sources behind a Mutation and streams behind a Query", async () => {
    const { service, define, agent } = await setup();
    await define({ name: "deploy", kind: "source", source: { run: `echo '{"ok":true}'`, access: "write" } });
    await define({ name: "ticks", kind: "source", source: { run: `echo '{"n":1}'; sleep 30`, mode: "stream", timeoutSeconds: 0 } });
    expect(await service.call(agent, "deploy", {}, "query")).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.call(agent, "deploy", {}, "mutation")).toMatchObject({ ok: true, data: { ok: true } });
    expect(await service.call(agent, "ticks", {}, "mutation")).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    service.close();
  });

  it("answers a stream call with its first frame, then serves changes by long poll", async () => {
    const { service, define, agent } = await setup();
    await define({ name: "ticks", kind: "source", source: { run: `echo '{"n":1}'; sleep 0.2; echo '{"n":2}'; sleep 30`, mode: "stream", timeoutSeconds: 0 } });
    const first = await service.call(agent, "ticks", {}, "query");
    expect(first).toMatchObject({ ok: true, mode: "stream", data: { n: 1 } });
    if (!first.ok || !first.streamId) throw new Error("expected a stream");
    const next = await service.read(first.streamId, first.cursor ?? 0, 3_000);
    expect(next).toMatchObject({ changed: true, data: { n: 2 } });
    service.stop(first.streamId);
    expect((await service.read(first.streamId, 0, 0)).state).toBe("gone");
    service.close();
  });

  it("returns a stream's failure instead of hanging", async () => {
    const { service, define, agent, project } = await setup();
    await writeFile(path.join(project, "flaky.sh"), `if [ -e ready ]; then echo '{"n":1}'; sleep 30; else echo down >&2; exit 1; fi`);
    const defined = await define({ name: "flaky", kind: "source", source: { run: "sh flaky.sh", mode: "stream", timeoutSeconds: 0 } });
    expect(defined.isError).toBe(true);
    await writeFile(path.join(project, "ready"), "");
    expect((await define({ name: "flaky", kind: "source", source: { run: "sh flaky.sh", mode: "stream", timeoutSeconds: 0 } })).isError).toBe(false);
    await import("node:fs/promises").then((fs) => fs.rm(path.join(project, "ready")));
    const result = await service.call(agent, "flaky", {}, "query");
    expect(result).toMatchObject({ ok: false, error: { kind: "exit" } });
    service.close();
  });

  it("scopes sources per project", async () => {
    const { service, define, agent } = await setup();
    await define({ name: "mine", kind: "source", source: { run: "echo '{}'" } });
    expect(await service.call({ ...agent, projectRoot: undefined }, "mine", {}, "query")).toMatchObject({ ok: false, error: { kind: "unknown-source" } });
    service.close();
  });
});
