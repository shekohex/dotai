import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { resolveConductorPaths } from "./paths.js";
import { ProgressStore } from "./progress-store.js";
import { GUIDE_URI, ProgressToolServer, STATE_URI } from "./progress-tools.js";

const agents: Record<string, { labels: Record<string, string> }> = {
  conductor: { labels: { "conductor.role": "coordinator" } },
  worker: { labels: { "paseo.parent-agent-id": "conductor" } },
  loner: { labels: {} },
};
const fakePaseo = {
  agents: {
    ref: (id: string) => ({
      refresh: async () => (agents[id] ? { agent: agents[id] } : null),
    }),
  },
} as unknown as PaseoApi;

let server: ProgressToolServer | undefined;
afterEach(async () => {
  await server?.close();
});

async function call(url: string, input: Record<string, unknown>) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const result = await client.callTool({ name: "progress", arguments: input });
  await client.close();
  return result;
}

describe("ProgressToolServer", () => {
  it("routes a worker's update to its conductor's state", async () => {
    const paths = resolveConductorPaths(
      await mkdtemp(path.join(os.tmpdir(), "tools-")),
    );
    const store = new ProgressStore(paths);
    server = new ProgressToolServer(paths, store);
    server.attach(fakePaseo);
    await server.start();

    const workerUrl = server.reserve();
    await server.bind(workerUrl, "worker");
    await call(workerUrl, { op: "start", title: "Run" });
    const reply = await call(workerUrl, {
      op: "ticket",
      title: "Task",
      status: "working",
    });
    expect(JSON.stringify(reply)).toContain("T01");
    expect((await store.state("conductor"))?.tickets).toHaveLength(1);

    const lonerUrl = server.reserve();
    await server.bind(lonerUrl, "loner");
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(lonerUrl)));
    expect((await client.listTools()).tools).toEqual([]);
    expect((await client.listResources()).resources).toEqual([]);
    await client.close();
  });

  it("lists the tool with annotations, and the guide and state as resources", async () => {
    const paths = resolveConductorPaths(
      await mkdtemp(path.join(os.tmpdir(), "tools-")),
    );
    const store = new ProgressStore(paths);
    server = new ProgressToolServer(paths, store);
    server.attach(fakePaseo);
    await server.start();
    const url = server.reserve();
    await server.bind(url, "worker");
    await call(url, { op: "start", title: "Ship the table" });

    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const [tool] = (await client.listTools()).tools;
    expect(tool?.name).toBe("progress");
    expect(tool?.annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: false,
    });
    const uris = (await client.listResources()).resources.map(
      (resource) => resource.uri,
    );
    expect(uris.sort()).toEqual([GUIDE_URI, STATE_URI]);
    const guide = await client.readResource({ uri: GUIDE_URI });
    expect(JSON.stringify(guide)).toContain("Progress dashboard");
    const state = await client.readResource({ uri: STATE_URI });
    expect(JSON.stringify(state)).toContain("Ship the table");
    await client.close();
  });

  it("keeps serving known workers after a restart, before Paseo is attached", async () => {
    const paths = resolveConductorPaths(
      await mkdtemp(path.join(os.tmpdir(), "tools-")),
    );
    const store = new ProgressStore(paths);
    server = new ProgressToolServer(paths, store);
    server.attach(fakePaseo);
    await server.start();
    const workerUrl = server.reserve();
    await server.bind(workerUrl, "worker");
    const lonerUrl = server.reserve();
    await server.bind(lonerUrl, "loner");
    await call(workerUrl, { op: "start", title: "Run" });
    await server.close();

    // A plugin reload: same registry on disk, no Paseo until some hook fires.
    server = new ProgressToolServer(paths, store);
    await server.start();
    expect(JSON.stringify(await call(workerUrl, { op: "show" }))).toContain(
      "Run",
    );
    const reply = await call(lonerUrl, { op: "show" });
    expect(reply.isError).toBe(true);
    expect(JSON.stringify(reply)).toContain("not working under a conductor");
  });

  it("lists the tool to an agent Paseo hasn't registered yet, then routes calls once it has", async () => {
    const paths = resolveConductorPaths(
      await mkdtemp(path.join(os.tmpdir(), "tools-")),
    );
    const store = new ProgressStore(paths);
    server = new ProgressToolServer(paths, store);
    server.attach(fakePaseo);
    await server.start();
    // Pi lists tools inside session creation: bound, but no agent record or parent label yet.
    const url = server.reserve();
    await server.bind(url, "pi-worker");
    const client = new Client({ name: "pi", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "progress",
    ]);
    const early = await client.callTool({
      name: "progress",
      arguments: { op: "show" },
    });
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early)).toContain("retry");

    agents["pi-worker"] = {
      labels: { "paseo.parent-agent-id": "conductor" },
    };
    try {
      expect((await client.listTools()).tools).toHaveLength(1);
      await client.callTool({
        name: "progress",
        arguments: { op: "start", title: "Pi run" },
      });
      expect((await store.state("conductor"))?.title).toBe("Pi run");
    } finally {
      delete agents["pi-worker"];
      await client.close();
    }
  });

  it("gives a worker of the new conductor the tool after the old one is archived", async () => {
    const paths = resolveConductorPaths(
      await mkdtemp(path.join(os.tmpdir(), "tools-")),
    );
    const store = new ProgressStore(paths);
    server = new ProgressToolServer(paths, store);
    server.attach(fakePaseo);
    await server.start();
    Object.assign(agents, {
      old: { labels: { "conductor.role": "coordinator" } },
      "old-worker": { labels: { "paseo.parent-agent-id": "old" } },
      next: { labels: { "conductor.role": "coordinator" } },
    });
    try {
      const oldUrl = server.reserve();
      await server.bind(oldUrl, "old-worker");
      await server.warm("old-worker");
      await call(oldUrl, { op: "start", title: "Old run" });
      delete agents["old"];
      delete agents["old-worker"];
      await server.forget("old");

      const url = server.reserve();
      await server.bind(url, "new-worker");
      const client = new Client({ name: "pi", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      expect((await client.listTools()).tools).toHaveLength(1);
      agents["new-worker"] = { labels: { "paseo.parent-agent-id": "next" } };
      await client.callTool({
        name: "progress",
        arguments: { op: "start", title: "New run" },
      });
      await client.close();
      expect((await store.state("next"))?.title).toBe("New run");
      expect((await store.state("old"))?.title).toBe("Old run");
      const registry = JSON.parse(
        await readFile(path.join(paths.root, "progress-tools.json"), "utf8"),
      ) as { conductors: Record<string, string> };
      expect(registry.conductors).toEqual({ "new-worker": "next" });
    } finally {
      for (const id of ["old", "old-worker", "next", "new-worker"])
        delete agents[id];
    }
  });
});
