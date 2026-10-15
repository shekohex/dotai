import { mkdtemp } from "node:fs/promises";
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
});
